// netlify/functions/ocr.js

exports.handler = async (event) => {
  // POST 이외 막기
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "METHOD_NOT_ALLOWED" }),
    };
  }

  try {
    // ---------- 1. body 파싱 + 여러 키 지원 ----------
    let imageBase64 = null;
    let pageIndex = 1;

    if (event.body) {
      let parsed = null;
      try {
        parsed = JSON.parse(event.body);
      } catch (e) {
        parsed = null;
      }

      if (parsed && typeof parsed === "object") {
        // 프론트에서 어떤 이름으로 보내도 다 받아보기
        pageIndex = parsed.pageIndex ?? 1;
        imageBase64 =
          parsed.imageBase64 ||
          parsed.image ||
          parsed.dataUrl ||
          parsed.dataURL ||
          parsed.photo ||
          parsed.img ||
          null;
      } else {
        // JSON이 아니라 그냥 문자열로 base64를 보낸 경우
        const raw = (event.body || "").trim();
        if (raw) imageBase64 = raw;
      }
    }

    if (!imageBase64) {
      // 여기가 지금 뜨는 부분이었음
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: "NO_IMAGE",
          debug: "imageBase64 / image / dataUrl 필드가 없음",
        }),
      };
    }

    // ---------- 2. 환경변수에서 API 키 읽기 ----------
    const apiKey =
      process.env.OCRSPACE_API_KEY ||
      process.env.OCRSPACE_APIKEY ||
      process.env.OCRSPACE_KEY;

    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: "NO_API_KEY",
          debug: "OCRSPACE_API_KEY 환경변수 없음",
        }),
      };
    }

    // dataURL 형태인지 확인 (data:image/jpeg;base64,....)
    const isDataUrl = imageBase64.startsWith("data:");

    const params = new URLSearchParams();
    params.append("apikey", apiKey);
    params.append("language", "kor,eng");
    params.append("OCREngine", "2");
    params.append(
      "base64Image",
      isDataUrl ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`
    );

    // ---------- 3. OCR.Space PRO 엔드포인트 호출 ----------
    const ocrResponse = await fetch("https://apipro1.ocr.space/parse/image", {
      method: "POST",
      body: params,
    });

    const rawText = await ocrResponse.text();

    if (!ocrResponse.ok) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: "OCR_HTTP_ERROR",
          status: ocrResponse.status,
          raw: rawText,
        }),
      };
    }

    let ocrJson;
    try {
      ocrJson = JSON.parse(rawText);
    } catch (e) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: "OCR_PARSE_ERROR",
          raw: rawText,
        }),
      };
    }

    const parsed =
      ocrJson &&
      ocrJson.ParsedResults &&
      ocrJson.ParsedResults[0] &&
      ocrJson.ParsedResults[0].ParsedText
        ? ocrJson.ParsedResults[0].ParsedText.trim()
        : "";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        ok: true,
        pageIndex,
        ocrText: parsed,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        error: "INTERNAL_ERROR",
        message: err.message || String(err),
      }),
    };
  }
};


