export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "method not allowed" });
    }

    const { imageDataUrl } = safeJson(event.body);
    if (!imageDataUrl || typeof imageDataUrl !== "string") {
      return json(400, { error: "imageDataUrl required" });
    }

    const apiKey = process.env.OCR_SPACE_API_KEY;
    const endpoint = process.env.OCR_SPACE_ENDPOINT || "https://apipro1.ocr.space/parse/image";

    if (!apiKey) return json(500, { error: "OCR_SPACE_API_KEY missing" });
    if (!endpoint) return json(500, { error: "OCR_SPACE_ENDPOINT missing" });

    // OCR.Space는 base64Image 파라미터로 dataURL도 받음
    const form = new URLSearchParams();
    form.set("apikey", apiKey);
    form.set("base64Image", imageDataUrl);
    form.set("language", "eng");
    form.set("OCREngine", "2");
    form.set("detectOrientation", "true");
    form.set("scale", "true");

    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });

    const raw = await r.json().catch(() => null);
    if (!r.ok) {
      return json(r.status, { error: `OCR upstream failed (${r.status})`, raw });
    }

    const parsedText =
      raw?.ParsedResults?.[0]?.ParsedText ??
      raw?.ParsedResults?.map(x => x.ParsedText).join("\n") ??
      "";

    // OCR.Space가 에러를 200으로 주는 경우도 있어 방어
    const isErrored = raw?.IsErroredOnProcessing;
    const errMsg = raw?.ErrorMessage || raw?.ErrorDetails;

    if (isErrored) {
      return json(502, { error: `OCR error: ${Array.isArray(errMsg) ? errMsg.join(" | ") : errMsg}`, raw });
    }

    return json(200, { text: String(parsedText || ""), raw });

  } catch (e) {
    return json(500, { error: e.message || String(e) });
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  };
}

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}
