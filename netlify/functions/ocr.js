// netlify/functions/ocr.js
// Netlify Functions (CJS)
// 필요 환경변수: OCR_SPACE_API_KEY

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "POST only" }) };
    }

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    const imageBase64 = body.imageBase64;

    if (!imageBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: "imageBase64 required" }) };
    }

    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "OCR_SPACE_API_KEY not set (Netlify 환경변수에 추가 필요)" })
      };
    }

    // OCR.Space form
    const form = new URLSearchParams();
    form.set("apikey", apiKey);
    form.set("base64Image", "data:image/jpeg;base64," + imageBase64);
    form.set("language", "eng");
    form.set("isOverlayRequired", "false");
    form.set("detectOrientation", "true");
    form.set("scale", "true");
    form.set("OCREngine", "2");

    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "OCR API error", raw: data }) };
    }

    const parsed = (data.ParsedResults && data.ParsedResults[0]) ? data.ParsedResults[0] : null;
    const text = (parsed && parsed.ParsedText ? parsed.ParsedText : "").trim();

    return {
      statusCode: 200,
      body: JSON.stringify({ text })
    };

  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || "OCR unknown error" }) };
  }
};

