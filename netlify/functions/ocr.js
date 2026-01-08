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
      "Content-Type": "application/json",
    },
    body: JSON.stringify(obj),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callOcrOnce(endpoint, apiKey, image, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const form = new URLSearchParams();
    form.append("base64Image", image);
    form.append("language", "eng");
    form.append("isOverlayRequired", "false");
    form.append("scale", "true");
    // PRO 엔진
    form.append("OCREngine", "2");

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: controller.signal,
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON from OCR.Space: " + text.slice(0, 200));
    }

    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} from OCR.Space: ${text.slice(0, 200)}`
      );
    }

    if (data.IsErroredOnProcessing) {
      const msg =
        (Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join("; ") : data.ErrorMessage) ||
        data.ErrorDetails ||
        "Unknown OCR error";
      throw new Error("OCR.Space processing error: " + msg);
    }

    return data;
  } finally {
    clearTimeout(id);
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) {
      return json(500, { ok: false, error: "OCR_SPACE_API_KEY is not set" });
    }

    const primaryEndpoint =
      process.env.OCR_SPACE_API_ENDPOINT ||
      "https://apipro1.ocr.space/parse/image";
    const backupEndpoint =
      process.env.OCR_SPACE_API_ENDPOINT_BACKUP ||
      "https://apipro2.ocr.space/parse/image";
    const timeoutMs = Number(process.env.OCR_SPACE_TIMEOUT_MS ?? 30000);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const image = body.image;
    const page = body.page ?? 1;

    if (!image || typeof image !== "string" || !image.startsWith("data:")) {
      return json(400, { ok: false, error: "Missing or invalid 'image' (dataURL) field" });
    }

    let data = null;
    let lastError = null;

    // 1차: primary
    try {
      data = await callOcrOnce(primaryEndpoint, apiKey, image, timeoutMs);
    } catch (err) {
      lastError = err;
    }

    // 2차: backup
    if (!data) {
      await sleep(300); // 잠깐 쉬고
      try {
        data = await callOcrOnce(backupEndpoint, apiKey, image, timeoutMs);
      } catch (err) {
        lastError = err;
      }
    }

    if (!data) {
      return json(502, {
        ok: false,
        error: "Both OCR endpoints failed",
        detail: String(lastError || "Unknown"),
      });
    }

    const parsedResults = Array.isArray(data.ParsedResults)
      ? data.ParsedResults
      : [];

    const texts = [];
    const confidences = [];

    for (const pr of parsedResults) {
      if (pr && typeof pr.ParsedText === "string") {
        texts.push(pr.ParsedText);
      }
      if (pr && typeof pr.MeanConfidence === "number") {
        confidences.push(pr.MeanConfidence);
      }
    }

    const fullText = texts.join("\n\n---PAGE BREAK---\n\n").trim();
    const avgConfidence =
      confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : 0;

    // 대략적인 "문항 번호 패턴" 카운트 (1. 2. or 1) 2) 등)
    let questionPatternCount = 0;
    if (fullText) {
      const matches = fullText.match(/\b\d{1,2}\s*[\.\)]/g);
      questionPatternCount = matches ? matches.length : 0;
    }

    return json(200, {
      ok: true,
      page,
      text: fullText,
      avgConfidence,
      questionPatternCount,
      rawExitCode: data.OCRExitCode,
      isErroredOnProcessing: !!data.IsErroredOnProcessing,
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "ocr internal error",
      detail: String(err && err.message ? err.message : err),
    });
  }
};


