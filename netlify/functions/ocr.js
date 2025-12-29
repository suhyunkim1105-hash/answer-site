// netlify/functions/ocr.js
// POST { imageBase64: "...." (raw base64 OR dataURL), language?: "eng" }
// Returns: { ok, text, meanConfidence, doneDetected, raw }

const OCR_ENDPOINT = "https://api.ocr.space/parse/image";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}

function ensureDataUrl(b64) {
  if (!b64) return "";
  if (b64.startsWith("data:image/")) return b64;
  // default jpeg
  return "data:image/jpeg;base64," + b64;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method Not Allowed" });

    const API_KEY = process.env.OCR_SPACE_API_KEY;
    if (!API_KEY) return json(500, { ok: false, error: "OCR_SPACE_API_KEY missing" });

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const imageBase64 = body.imageBase64 || body.base64Image || body.base64 || "";
    if (!imageBase64) {
      return json(400, { ok: false, error: "Missing imageBase64/base64Image" });
    }

    const language = body.language || "eng";

    const params = new URLSearchParams();
    params.set("apikey", API_KEY);
    params.set("language", language);
    params.set("isOverlayRequired", "false");
    params.set("detectOrientation", "true");
    params.set("scale", "true");
    params.set("OCREngine", "2");
    params.set("base64Image", ensureDataUrl(imageBase64));

    const resp = await fetch(OCR_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const textRaw = await resp.text();
    let data;
    try {
      data = JSON.parse(textRaw);
    } catch {
      return json(502, {
        ok: false,
        error: "OCR non-JSON response",
        status: resp.status,
        detail: textRaw.slice(0, 400),
      });
    }

    if (!resp.ok) {
      return json(502, { ok: false, error: "OCR HTTP error", status: resp.status, detail: data });
    }

    if (data.IsErroredOnProcessing) {
      return json(502, {
        ok: false,
        error: "OCR errored",
        detail: data.ErrorMessage || data.ErrorDetails || data,
      });
    }

    const parsed = (data.ParsedResults && data.ParsedResults[0]) ? data.ParsedResults[0] : null;
    const parsedText = (parsed && parsed.ParsedText) ? parsed.ParsedText : "";
    const meanConfidence = (parsed && typeof parsed.MeanConfidence !== "undefined")
      ? Number(parsed.MeanConfidence)
      : null;

    const doneDetected = /\bDONE\b/i.test(parsedText);

    return json(200, {
      ok: true,
      text: parsedText,
      meanConfidence,
      doneDetected,
      raw: {
        OCRExitCode: data.OCRExitCode,
        ProcessingTimeInMilliseconds: data.ProcessingTimeInMilliseconds,
        SearchablePDFURL: data.SearchablePDFURL || null,
      },
    });
  } catch (e) {
    return json(500, { ok: false, error: "Server error", detail: String(e && e.message ? e.message : e) });
  }
};

