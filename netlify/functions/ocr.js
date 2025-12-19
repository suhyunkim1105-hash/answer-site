// netlify/functions/ocr.js

// Netlify Functions (Node 18 기준)에서는 fetch가 기본 내장되어 있음.
// 따로 node-fetch 같은 패키지 import 할 필요 없음.

exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };

  // 프리플라이트 대응
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED" }),
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

  // 프론트에서 보내는 필드: imageBase64 (당신 코드 기준 b64 문자열)
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

  // 2) 순수 base64 / dataURL 모두 처리
  // - 네 자동 OCR 코드(b64)는 순수 base64 형태
  // - 혹시 data:image/jpeg;base64,... 형태여도 같이 처리
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

  // x-www-form-urlencoded 로 전송 (OCR.Space 공식 방식)
  const form = new URLSearchParams();
  form.set("apikey", apiKey);
  form.set("language", "kor+eng"); // 한글 + 영어
  form.set("isOverlayRequired", "false");
  form.set("scale", "true");
  form.set("OCREngine", "3");
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
      // 여기서 403 등 나오면 그대로 프론트에 전달
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

    // OCR.Space 에러 플래그 체크
    if (data.IsErroredOnProcessing) {
      const errMsg =
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
          message: errMsg,
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

    // 프론트(index.html)가 기대하는 필드 이름에 맞춤:
    // data.text, data.conf
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



