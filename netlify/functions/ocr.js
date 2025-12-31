// netlify/functions/ocr.js
export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "POST only" }) };
    }

    // ✅ 변수명 두 개 다 허용(네 Netlify에 OCR_SPACE_API_KEY로 되어있음)
    const key = process.env.OCR_SPACE_API_KEY || process.env.OCR_SPACE_API_KEY;
    const endpoint = process.env.OCR_SPACE_ENDPOINT || "https://apipro2.ocr.space/parse/image";

    if (!key) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing OCR_SPACE_API_KEY" }) };
    }

    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

    const image = body.image;
    if (!image || typeof image !== "string" || !image.startsWith("data:image/")) {
      return { statusCode: 400, body: JSON.stringify({ error: "image (dataURL) required" }) };
    }

    const form = new URLSearchParams();
    form.set("apikey", key);
    form.set("base64Image", image);
    form.set("language", "eng");
    form.set("OCREngine", "2");
    form.set("scale", "true");
    form.set("detectOrientation", "true");
    form.set("isOverlayRequired", "false");
    form.set("isTable", "false");

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      return { statusCode: 502, body: JSON.stringify({ error: "OCR endpoint failed" }) };
    }

    if (data.IsErroredOnProcessing) {
      return { statusCode: 502, body: JSON.stringify({ error: data.ErrorMessage || "OCR error" }) };
    }

    const parsed = data.ParsedResults?.[0];
    const text = parsed?.ParsedText || "";

    return { statusCode: 200, body: JSON.stringify({ text }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || "unknown" }) };
  }
};
