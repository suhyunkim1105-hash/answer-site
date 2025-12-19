// netlify/functions/ocr.js

// Netlify Functions(Node 18 기준)에서는 fetch가 기본 내장되어 있음.

exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({
        ok: false,
        error: "METHOD_NOT_ALLOWED",
        message: "POST로 호출해야 합니다.",
      }),
    };
  }

  // 1) body 파싱
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        ok: false,
        error: "INVALID_JSON",
        detail: String(e.message || e),
      }),
    };
  }

  // 프론트에서 보내는 필드 이름들 호환
  let imageBase64 =
    body.imageBase64 ||
    body.imageDataUrl ||
    body.image ||
    body.dataUrl ||
    "";

  if (!imageBase64 || typeof imageBase64 !== "string") {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        ok: false,
        error: "NO_IMAGE",
        message: "imageBase64(또는 imageDataUrl)가 비어 있습니다.",
        receivedKeys: Object.keys(body),
      }),
    };
  }

  // 2) base64 추출 (dataURL / 순수 base64 둘 다 처리)
  let base64Part = imageBase64;
  const idx = imageBase64.indexOf("base64,");
  if (idx >= 0) {
    base64Part = imageBase64.slice(idx + "base64,".length);
  }

  const apiKey = process.env.OCRSPACE_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        error: "NO_OCRSPACE_API_KEY",
        message: "Netlify 환경변수 OCRSPACE_API_KEY 가 설정되어 있지 않습니다.",
      }),
    };
  }

  // 3) OCR.Space PRO 엔드포인트 (apipro1)
  const endpoint = "https://apipro1.ocr.space/parse/image";

  // 공식 권장: application/x-www-form-urlencoded
  const form = new URLSearchParams();
  form.set("apikey", apiKey);
  // ★ 여기 language를 단일 코드로 고정 (E201 방지)
  form.set("language", "kor"); // 한국어 기준. 영어 텍스트도 대부분 인식됨.
  form.set("isOverlayRequired", "false");
  form.set("scale", "true");
  form.set("detectOrientation", "true");
  form.set("OCREngine", "2");
  form.set("base64Image", "data:image/jpeg;base64," + base64Part);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    const rawText = await resp.text();

    if (!resp.ok) {
      // HTTP 레벨 에러(403 등)는 ok:false로 감싸서 프론트에 전달
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: false,
          error: "OCR_HTTP_ERROR",
          status: resp.status,
          raw: rawText.slice(0, 300),
        }),
      };
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: false,
          error: "OCR_JSON_PARSE_ERROR",
          raw: rawText.slice(0, 300),
        }),
      };
    }

    if (data.IsErroredOnProcessing) {
      const msg =
        (Array.isArray(data.ErrorMessage)
          ? data.ErrorMessage.join(" / ")
          : data.ErrorMessage) ||
        data.ErrorDetails ||
        "OCR.Space 처리 오류";

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: false,
          error: "OCR_PROCESSING_ERROR",
          message: msg,
        }),
      };
    }

    const parsed = data.ParsedResults && data.ParsedResults[0];
    const text = parsed && parsed.ParsedText ? parsed.ParsedText : "";
    const conf =
      typeof parsed?.MeanConfidenceLevel === "number"
        ? parsed.MeanConfidenceLevel
        : 0;

    if (!text.trim()) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: false,
          error: "EMPTY_OCR_TEXT",
          message: "OCR 결과 텍스트가 비어 있습니다.",
        }),
      };
    }

    // index.html 자동 OCR 코드에서 기대하는 필드명: text, conf, note
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        text,
        conf,
        note: "OCR 성공",
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        error: "OCR_REQUEST_FAILED",
        message: String(e.message || e),
      }),
    };
  }
};



