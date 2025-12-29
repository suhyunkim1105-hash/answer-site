// netlify/functions/ocr.js
// OCR.Space proxy (CommonJS)
// Required environment variable: OCR_SPACE_API_KEY

const OCR_ENDPOINT = "https://api.ocr.space/parse/image";

function json(statusCode, obj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      ...extraHeaders,
    },
    body: JSON.stringify(obj),
  };
}

function countQuestions(text) {
  // Count patterns like "01", "1.", "1 " etc
  const hits = new Set();
  const re = /(?:^|\n|\s)(\d{1,2})(?:\s*[\).\]]|\s)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 50) hits.add(n);
  }
  return hits.size;
}

function detectDone(text) {
  return /\bDONE\b/i.test(text);
}

exports.handler = async (event) => {
  try {
    // Handle preflight (CORS)
    if (event.httpMethod === "OPTIONS") {
      return json(204, {}, { "Content-Length": "0" });
    }

    if (event.httpMethod !== "POST") {
      return json(405, { error: "POST only" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const imageBase64 = body.imageBase64;
    if (!imageBase64 || typeof imageBase64 !== "string") {
      return json(400, { error: "imageBase64 required" });
    }

    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) {
      return json(500, { error: "OCR_SPACE_API_KEY not set (Netlify 환경변수에 추가 필요)" });
    }

    // OCR.Space form
    const form = new URLSearchParams();
    form.set("apikey", apiKey);
    form.set("base64Image", "data:image/jpeg;base64," + imageBase64);
    form.set("language", body.language || "eng");
    form.set("isOverlayRequired", "false");
    form.set("detectOrientation", "true");
    form.set("scale", "true");
    form.set("OCREngine", String(body.engine || 2)); // 2 default

    const resp = await fetch(OCR_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return json(502, { error: "OCR API error", status: resp.status, raw: data });
    }

    if (data.IsErroredOnProcessing) {
      return json(502, { error: "OCR processing error", raw: data });
    }

    const parsed = data.ParsedResults?.[0] || null;
    const text = (parsed?.ParsedText || "").trim();

    const len = text.length;
    const qCount = countQuestions(text);
    const done = detectDone(text);

    // Score: question count is most important, then length
    const score = qCount * 10 + Math.min(len / 20, 120);

    return json(200, {
      ok: true,
      text,
      meta: { len, qCount, done, score },
    });
  } catch (e) {
    return json(500, { error: e?.message || "OCR unknown error" });
  }
};

