// netlify/functions/ocr.js
// OCR.Space 호출: 이미지 1장 -> { text, conf }
// conf는 OCR.Space 응답 구조가 바뀔 수 있으므로(확실하지 않음) 가능한 경우만 추출하고, 없으면 null 반환.

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) return json(500, { ok: false, error: "Missing OCR_SPACE_API_KEY" });

    const body = safeJson(event.body);
    const imageDataUrl = body?.imageDataUrl;
    if (!imageDataUrl || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
      return json(400, { ok: false, error: "Invalid imageDataUrl" });
    }

    // OCR.Space는 base64Image 필드에 "data:image/jpeg;base64,..." 그대로 받는 방식이 일반적이다.
    const form = new URLSearchParams();
    form.set("apikey", apiKey);
    form.set("base64Image", imageDataUrl);
    form.set("language", "eng");          // 시험은 영어가 메인
    form.set("OCREngine", "2");           // 보통 2가 더 나은 경우가 많음(케이스에 따라 다를 수 있음)
    form.set("detectOrientation", "true");
    form.set("scale", "true");            // 작은 글씨에 도움이 되는 경우가 있음
    form.set("isOverlayRequired", "true"); // conf 계산 시도용(없으면 null)

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

    // OCR.Space 성공 여부
    // 보통 IsErroredOnProcessing, ErrorMessage, OCRExitCode 등을 준다.
    if (data.IsErroredOnProcessing) {
      const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(" / ") : (data.ErrorMessage || "OCR error");
      return json(200, { ok: false, error: msg });
    }

    const parsed = data?.ParsedResults?.[0];
    const text = (parsed?.ParsedText || "").trim();
    if (!text) {
      return json(200, { ok: false, error: "Empty OCR text" });
    }

    // conf 추출 시도
    const conf = extractConfidence(parsed);

    return json(200, { ok: true, text, conf });
  } catch (e) {
    // AbortError 포함
    return json(500, { ok: false, error: String(e?.message || e) });
  }
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

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch { return null; }
}

function extractConfidence(parsed) {
  // 1) MeanConfidence가 있으면 사용(0~100 가정)
  const mc = parsed?.MeanConfidence;
  if (typeof mc === "number" && isFinite(mc)) {
    const v = clamp01(mc / 100);
    return v;
  }

  // 2) TextOverlay → Words → WordConf 평균(0~100 가정)
  const lines = parsed?.TextOverlay?.Lines;
  if (Array.isArray(lines)) {
    const confs = [];
    for (const ln of lines) {
      const words = ln?.Words;
      if (!Array.isArray(words)) continue;
      for (const w of words) {
        const wc = w?.WordConf;
        if (typeof wc === "number" && isFinite(wc)) confs.push(wc);
        // 어떤 응답은 string일 수 있어 방어
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

  // 3) 없으면 null
  return null;
}

function clamp01(x) {
  if (!isFinite(x)) return null;
  return Math.max(0, Math.min(1, x));
}
