// netlify/functions/ocr.js
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const key = process.env.OCR_SPACE_API_KEY || "";
    console.log("[ocr] OCR_SPACE_API_KEY length =", key.length);

    if (!key) return json(500, { ok:false, error:"Missing OCR_SPACE_API_KEY" });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    const imageBase64 = body.imageBase64;

    if (!imageBase64 || typeof imageBase64 !== "string") {
      return json(400, { ok:false, error:"Missing imageBase64/base64Image" });
    }

    // OCR.space는 "base64Image=data:image/jpeg;base64,..." 형식 지원
    const form = new FormData();
    form.set("apikey", key);
    form.set("language", "eng");
    form.set("isOverlayRequired", "false");
    form.set("detectOrientation", "true");
    form.set("isCreateSearchablePdf", "false");
    form.set("isSearchablePdfHideTextLayer", "true");
    form.set("base64Image", imageBase64);

    const r = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      body: form
    });

    const raw = await r.text();
    let data = {};
    try { data = JSON.parse(raw); } catch {
      return json(502, { ok:false, error:"OCR non-JSON response", detail: raw.slice(0, 300) });
    }

    if (!r.ok) {
      return json(502, { ok:false, error:"OCR HTTP error", status:r.status, detail: data?.ErrorMessage || raw });
    }

    // OCR.space 표준 응답
    if (data?.IsErroredOnProcessing) {
      return json(502, {
        ok:false,
        error:"OCR processing error",
        detail: Array.isArray(data?.ErrorMessage) ? data.ErrorMessage.join(" | ") : (data?.ErrorMessage || "unknown")
      });
    }

    const parsed = data?.ParsedResults?.[0];
    const text = (parsed?.ParsedText || "").trim();

    // confidence 계산(없을 수도 있어서 안전)
    const confStr = parsed?.TextOverlay?.Lines?.length
      ? null
      : (parsed?.MeanConfidenceLevel ?? parsed?.MeanConfidenceLevel ?? null);

    let confidence = 0.0;
    // OCR.space는 MeanConfidenceLevel(0~100)을 주는 경우가 많음
    const m = parsed?.MeanConfidenceLevel;
    if (typeof m === "number") confidence = Math.max(0, Math.min(1, m / 100));
    else confidence = text.length ? 0.55 : 0.0;

    const doneDetected = /\bDONE\b/i.test(text);

    return json(200, {
      ok: true,
      text,
      confidence,
      doneDetected
    });

  } catch (e) {
    return json(500, { ok:false, error:"Server error", detail: e?.message || String(e) });
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST,OPTIONS"
    },
    body: JSON.stringify(obj)
  };
}
