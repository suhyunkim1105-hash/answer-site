// netlify/functions/ocr.js
// OCR.Space PRO 호출 (apipro1/apipro2). JSON(dataURL base64) 받아서 base64Image로 전달.
// - env: OCR_SPACE_API_KEY (필수)
// - env: OCR_SPACE_API_ENDPOINT (권장: https://apipro1.ocr.space/parse/image)
// - env: OCR_SPACE_API_ENDPOINT_BACKUP (권장: https://apipro2.ocr.space/parse/image)
// - env: OCR_SPACE_TIMEOUT_MS (옵션, 기본 30000)

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    },
    body: JSON.stringify(obj)
  };
}

function timeoutPromise(ms, message) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message || "Timeout")), ms);
  });
}

async function callOcrEndpoint(endpoint, apiKey, imageDataUrl) {
  const form = new URLSearchParams();
  // OCR.Space는 data:image/jpeg;base64,... 형태도 그대로 받는다.
  form.append("base64Image", imageDataUrl);
  form.append("language", "eng");
  form.append("isOverlayRequired", "false");
  form.append("OCREngine", "2");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: apiKey,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  if (!res.ok) {
    throw new Error(`OCR HTTP ${res.status}`);
  }

  const data = await res.json();
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json(200, { ok: true });
  }
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "POST only" });
  }

  const apiKey = process.env.OCR_SPACE_API_KEY;
  if (!apiKey) {
    return json(500, { ok: false, error: "OCR_SPACE_API_KEY is not set" });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  const image = body.image || body.base64Image;
  const page = body.page ?? null;

  if (!image || typeof image !== "string") {
    return json(400, { ok: false, error: "image(dataURL) is required" });
  }

  const primaryEndpoint =
    process.env.OCR_SPACE_API_ENDPOINT ||
    "https://apipro1.ocr.space/parse/image";
  const backupEndpoint =
    process.env.OCR_SPACE_API_ENDPOINT_BACKUP ||
    "https://apipro2.ocr.space/parse/image";

  const timeoutMs = Number(process.env.OCR_SPACE_TIMEOUT_MS || 30000);

  let lastError = null;

  const tryOnce = async (endpoint) => {
    const ocrPromise = callOcrEndpoint(endpoint, apiKey, image);
    const data = await Promise.race([
      ocrPromise,
      timeoutPromise(timeoutMs, "OCR timeout")
    ]);
    return data;
  };

  try {
    let data = await tryOnce(primaryEndpoint).catch((err) => {
      lastError = err;
      return null;
    });

    if (!data && backupEndpoint) {
      data = await tryOnce(backupEndpoint).catch((err) => {
        lastError = err;
        return null;
      });
    }

    if (!data) {
      return json(500, {
        ok: false,
        error: lastError ? lastError.message : "OCR failed"
      });
    }

    if (data.IsErroredOnProcessing) {
      const errMsg =
        (Array.isArray(data.ErrorMessage) && data.ErrorMessage[0]) ||
        data.ErrorMessage ||
        "OCR error";
      return json(500, { ok: false, error: errMsg });
    }

    const results = data.ParsedResults || [];
    const fullText = results
      .map((r) => (r && r.ParsedText) || "")
      .join("\n");

    return json(200, {
      ok: true,
      text: fullText,
      debug: {
        page,
        isErrored: data.IsErroredOnProcessing,
        processingTimeInMs: data.ProcessingTimeInMilliseconds,
        ocrEndpoint: data.OCRExitCode
      }
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: err.message || "Unexpected OCR error"
    });
  }
};

