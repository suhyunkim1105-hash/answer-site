// netlify/functions/ocr.js  (그대로 덮어쓰기)
// OCR.Space PRO endpoint(apipro1/apipro2) + base64 업로드
export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "POST only" }) };
    }

    const { OCR_SPACE_API_KEY, OCR_SPACE_ENDPOINT } = process.env;
    if (!OCR_SPACE_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing OCR_SPACE_API_KEY" }) };
    }

    const endpoint = OCR_SPACE_ENDPOINT || "https://apipro2.ocr.space/parse/image";

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { body = {}; }

    const image = body.image;
    if (!image || typeof image !== "string" || !image.startsWith("data:image/")) {
      return { statusCode: 400, body: JSON.stringify({ error: "image (dataURL) required" }) };
    }

    const form = new URLSearchParams();
    form.set("apikey", OCR_SPACE_API_KEY);
    form.set("base64Image", image);
    form.set("language", "eng");
    form.set("OCREngine", "2");              // 보통 엔진2가 더 안정적
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
      return { statusCode: 502, body: JSON.stringify({ error: data.ErrorMessage || "OCR error", raw: data }) };
    }

    const parsed = (data.ParsedResults && data.ParsedResults[0]) ? data.ParsedResults[0] : null;
    const text = (parsed && parsed.ParsedText) ? parsed.ParsedText : "";

    return {
      statusCode: 200,
      body: JSON.stringify({
        text,
        // 필요하면 raw 열어볼 수 있게 유지(디버그용)
        raw: { OCRExitCode: data.OCRExitCode, ErrorMessage: data.ErrorMessage, ProcessingTimeInMilliseconds: data.ProcessingTimeInMilliseconds }
      }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || "unknown" }) };
  }
};
