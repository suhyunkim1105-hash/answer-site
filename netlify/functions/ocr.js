// netlify/functions/ocr.js
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const body = safeJson(event.body);
    const image = body && typeof body.image === "string" ? body.image.trim() : "";
    if (!image) {
      return json(400, { ok: false, error: "Missing image" });
    }

    const apiKey =
      (process.env.OCR_SPACE_API_KEY || "").trim() ||
      (process.env.OCRSPACE_API_KEY || "").trim() ||
      (process.env.OCR_API_KEY || "").trim();

    if (!apiKey) {
      return json(500, { ok: false, error: "Missing OCR_SPACE_API_KEY env var" });
    }

    const endpoint =
      (process.env.OCR_SPACE_ENDPOINT || "").trim() ||
      "https://api.ocr.space/parse/image";

    // data:image/jpeg;base64,... 전체를 그대로 보낸다.
    const form = new URLSearchParams();
    form.append("apikey", apiKey);
    form.append("base64Image", image);
    form.append("language", "eng");
    form.append("isOverlayRequired", "false");
    form.append("detectOrientation", "true");
    form.append("scale", "true");
    form.append("OCREngine", "2");

    const timeoutMs = Number(process.env.OCR_SPACE_TIMEOUT_MS || 25000);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    let resp;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded"
        },
        body: form.toString(),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(t);
      return json(200, {
        ok: false,
        error: "OCR.Space fetch failed",
        detail: String(e && e.message ? e.message : e)
      });
    }
    clearTimeout(t);

    let data;
    try {
      data = await resp.json();
    } catch (_) {
      data = {};
    }

    if (!resp.ok) {
      return json(200, {
        ok: false,
        error: "OCR.Space HTTP error",
        detail: data
      });
    }

    if (data.IsErroredOnProcessing) {
      const detail =
        (Array.isArray(data.ErrorMessage) && data.ErrorMessage.join(" / ")) ||
        data.ErrorMessage ||
        data.ErrorDetails ||
        "Unknown OCR error";
      return json(200, {
        ok: false,
        error: "OCR.Space upstream error",
        detail
      });
    }

    const results = Array.isArray(data.ParsedResults) ? data.ParsedResults : [];
    if (!results.length || !results[0].ParsedText) {
      return json(200, {
        ok: false,
        error: "No text parsed",
        detail: data
      });
    }

    const parsedText = String(results[0].ParsedText || "");
    const meanConf = Number(
      results[0].MeanConfidence != null
        ? results[0].MeanConfidence
        : data.MeanConfidence != null
        ? data.MeanConfidence
        : 0
    );
    const hits = countHits(parsedText);

    return json(200, {
      ok: true,
      text: parsedText,
      conf: Number.isFinite(meanConf) ? meanConf : 0,
      hits
    });
  } catch (e) {
    const msg =
      e && e.name === "AbortError"
        ? "OCR.Space timeout"
        : String(e && e.message ? e.message : e);
    return json(200, { ok: false, error: msg });
  }
}

function countHits(text) {
  if (!text) return 0;
  const m = text.match(/\b(0?[1-9]|[1-4][0-9])\s*[\)\.]/g) || [];
  return m.length;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(obj)
  };
}

function safeJson(str) {
  try {
    return JSON.parse(str || "{}");
  } catch (_) {
    return {};
  }
}
