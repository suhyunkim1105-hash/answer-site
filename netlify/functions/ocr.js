// netlify/functions/ocr.js
// Netlify Functions (CJS)
// 필요 환경변수: OCR_SPACE_API_KEY

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "POST only" }),
      };
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    let imageBase64 = body.imageBase64 || body.image || "";
    if (!imageBase64 || typeof imageBase64 !== "string") {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "imageBase64 required" }),
      };
    }

    // 허용 형태:
    // - "data:image/jpeg;base64,...."
    // - "....(순수 base64)..."
    imageBase64 = imageBase64.trim();
    if (imageBase64.startsWith("data:")) {
      const idx = imageBase64.indexOf("base64,");
      if (idx !== -1) imageBase64 = imageBase64.slice(idx + "base64,".length).trim();
    }
    // 공백 제거(간혹 줄바꿈 섞임)
    imageBase64 = imageBase64.replace(/\s+/g, "");

    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "OCR_SPACE_API_KEY not set (Netlify 환경변수에 추가 필요)" }),
      };
    }

    const language = (body.language && String(body.language)) || "eng";
    const ocrEngine = (body.ocrEngine && String(body.ocrEngine)) || "2";

    const form = new URLSearchParams();
    form.set("apikey", apiKey);
    form.set("base64Image", "data:image/jpeg;base64," + imageBase64);
    form.set("language", language);
    form.set("isOverlayRequired", "false");
    form.set("detectOrientation", "true");
    form.set("scale", "true");
    form.set("OCREngine", ocrEngine);

    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "OCR API error", raw: data }),
      };
    }

    const parsed = data?.ParsedResults?.[0] || null;
    const text = (parsed?.ParsedText || "").trim();

    // OCR.Space는 성공이어도 IsErroredOnProcessing=true인 경우가 있음
    if (data?.IsErroredOnProcessing) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: "OCR processing error",
          message: data?.ErrorMessage || null,
          text,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ text }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: e?.message || "OCR unknown error" }),
    };
  }
};
