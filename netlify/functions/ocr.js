// netlify/functions/ocr.js
// Server-side OCR (OCR.space PRO) - API Key 절대 프론트에 노출하지 않음

exports.handler = async (event) => {
  try {
    // CORS + preflight
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders, body: "" };
    }
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: "POST only" }) };
    }

    const { imageBase64, language = "eng", ocrEngine = 2 } = JSON.parse(event.body || "{}");
    if (!imageBase64 || typeof imageBase64 !== "string") {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "imageBase64 required" }) };
    }

    const OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY;
    const OCR_SPACE_ENDPOINT = process.env.OCR_SPACE_ENDPOINT; // ex) https://apipro1.ocr.space/parse/image
    if (!OCR_SPACE_API_KEY) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "OCR_SPACE_API_KEY missing" }) };
    }
    if (!OCR_SPACE_ENDPOINT) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "OCR_SPACE_ENDPOINT missing" }) };
    }

    // OCR.space expects multipart/form-data OR x-www-form-urlencoded.
    // 여기서는 URLSearchParams로 간단히 보냄.
    const form = new URLSearchParams();
    form.set("apikey", OCR_SPACE_API_KEY);
    form.set("base64Image", imageBase64);               // data:image/jpeg;base64,...
    form.set("language", language);
    form.set("OCREngine", String(ocrEngine));           // 1 or 2
    form.set("scale", "true");
    form.set("detectOrientation", "true");
    form.set("isOverlayRequired", "true");              // WordConfidence 받기
    form.set("filetype", "JPG");

    const resp = await fetch(OCR_SPACE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({ error: "OCR upstream error", status: resp.status, raw: data }),
      };
    }

    if (data.IsErroredOnProcessing) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ error: data.ErrorMessage || "OCR processing error", raw: data }),
      };
    }

    const parsed = data?.ParsedResults?.[0];
    const text = (parsed?.ParsedText || "").trim();

    // avg word confidence 계산
    let avgConfidence = null;
    try {
      const words = [];
      const lines = parsed?.TextOverlay?.Lines || [];
      for (const line of lines) {
        for (const w of (line?.Words || [])) {
          const c = Number(w?.WordConfidence);
          if (!Number.isNaN(c)) words.push(c);
        }
      }
      if (words.length) {
        avgConfidence = words.reduce((a, b) => a + b, 0) / words.length;
      }
    } catch (_) {}

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        text,
        avgConfidence,          // null or number (0~100)
        length: text.length,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: String(e) }) };
  }
};
