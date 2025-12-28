// netlify/functions/ocr.js (CommonJS)
// OCR.Space 호출: 이미지 1장 -> { ok, text, conf }
// conf는 가능한 경우만 추출하고 없으면 null.

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) return json(500, { ok: false, error: "Missing OCR_SPACE_API_KEY" });

    const body = safeJson(event.body);
    const imageDataUrl = body && body.imageDataUrl;

    if (!imageDataUrl || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
      return json(400, { ok: false, error: "Invalid imageDataUrl" });
    }

    const form = new URLSearchParams();
    form.set("apikey", apiKey);
    form.set("base64Image", imageDataUrl);
    form.set("language", "eng");             // 편입영어
    form.set("OCREngine", "2");
    form.set("detectOrientation", "true");
    form.set("scale", "true");
    form.set("isOverlayRequired", "true");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return json(502, { ok: false, error: `OCR API HTTP ${resp.status}: ${t.slice(0,200)}` });
    }

    const data = await resp.json().catch(() => null);
    if (!data) return json(502, { ok: false, error: "OCR API returned invalid JSON" });

    if (data.IsErroredOnProcessing) {
      const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(" / ") : (data.ErrorMessage || "OCR error");
      return json(200, { ok: false, error: msg });
    }

    const parsed = data && data.ParsedResults && data.ParsedResults[0];
    const text = (parsed && parsed.ParsedText ? String(parsed.ParsedText) : "").trim();

    if (!text) return json(200, { ok: false, error: "Empty OCR text" });

    const conf = extractConfidence(parsed);

    return json(200, { ok: true, text, conf });
  } catch (e) {
    return json(500, { ok: false, error: String(e && (e.message || e)) });
  }
};

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

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch { return null; }
}

function extractConfidence(parsed) {
  // 1) MeanConfidence(0~100)
  const mc = parsed && parsed.MeanConfidence;
  if (typeof mc === "number" && isFinite(mc)) return clamp01(mc / 100);

  // 2) TextOverlay -> Words -> WordConf 평균(0~100)
  const lines = parsed && parsed.TextOverlay && parsed.TextOverlay.Lines;
  if (Array.isArray(lines)) {
    const confs = [];
    for (const ln of lines) {
      const words = ln && ln.Words;
      if (!Array.isArray(words)) continue;
      for (const w of words) {
        const wc = w && w.WordConf;
        if (typeof wc === "number" && isFinite(wc)) confs.push(wc);
        if (typeof wc === "string") {
          const num = Number(wc);
          if (isFinite(num)) confs.push(num);
        }
      }
    }
    if (confs.length > 0) {
      const avg = confs.reduce((a,b)=>a+b,0) / confs.length;
      return clamp01(avg / 100);
    }
  }

  return null;
}

function clamp01(x) {
  if (!isFinite(x)) return null;
  return Math.max(0, Math.min(1, x));
}
