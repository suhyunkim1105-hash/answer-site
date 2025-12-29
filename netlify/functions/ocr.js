// netlify/functions/ocr.js
// OCR.Space: imageDataUrl(base64 jpeg/png) -> { ok:true, text, conf }
// conf는 0~1 범위(추정)

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { ok:false, error:"Method Not Allowed" });

    const apiKey = process.env.OCR_SPACE_API_KEY || process.env.OCRSPACE_API_KEY || process.env.OCR_SPACE_APIKEY;
    if (!apiKey) return json(500, { ok:false, error:"Missing OCR_SPACE_API_KEY" });

    const body = safeJson(event.body);
    const imageDataUrl = body && body.imageDataUrl;

    if (!imageDataUrl || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
      return json(400, { ok:false, error:"Invalid imageDataUrl" });
    }

    const form = new URLSearchParams();
    form.set("apikey", apiKey);
    form.set("base64Image", imageDataUrl);
    form.set("language", "eng");
    form.set("OCREngine", "2");
    form.set("detectOrientation", "true");
    form.set("scale", "true");
    form.set("isOverlayRequired", "false");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { "content-type":"application/x-www-form-urlencoded" },
      body: form,
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    if (!resp.ok) {
      const t = await resp.text().catch(()=> "");
      return json(502, { ok:false, error:`OCR API HTTP ${resp.status}: ${t.slice(0,200)}` });
    }

    const data = await resp.json().catch(() => null);
    if (!data) return json(502, { ok:false, error:"OCR API returned invalid JSON" });

    if (data.IsErroredOnProcessing) {
      const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(" / ") : (data.ErrorMessage || "OCR error");
      return json(200, { ok:false, error: msg });
    }

    const parsed = data.ParsedResults && data.ParsedResults[0];
    const text = (parsed && parsed.ParsedText ? String(parsed.ParsedText) : "").trim();
    if (!text) return json(200, { ok:false, error:"Empty OCR text" });

    const conf = extractConfidence01(parsed);

    return json(200, { ok:true, text, conf });
  } catch (e) {
    return json(500, { ok:false, error: String(e && (e.message || e)) });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store"
    },
    body: JSON.stringify(obj)
  };
}

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch { return null; }
}

// OCR.Space 응답의 MeanConfidence(0~100)를 0~1로 변환
function extractConfidence01(parsed) {
  const mc = parsed && parsed.MeanConfidence;
  if (typeof mc === "number" && isFinite(mc)) return clamp01(mc / 100);

  // 없으면 중립값
  return 0.45;
}
function clamp01(x) {
  if (!isFinite(x)) return 0.45;
  return Math.max(0, Math.min(1, x));
}
