// netlify/functions/ocr.js
// 입력: { image: "data:image/jpeg;base64,...", pageIndex, mode }
// 출력: { ok:true, text, conf } 또는 { ok:false, error, detail }

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok:false, error:"Method Not Allowed" });
    }

    const key = process.env.OCR_SPACE_API_KEY;
    if (!key) {
      return json(200, { ok:false, error:"Missing OCR_SPACE_API_KEY env var" });
    }

    const body = safeJson(event.body);
    const img = String(body?.image || "");
    if (!img.startsWith("data:image/")) {
      return json(200, { ok:false, error:"Missing image dataUrl" });
    }

    const base64 = img.split(",")[1] || "";
    if (base64.length < 1000) {
      return json(200, { ok:false, error:"Image too small" });
    }

    const form = new URLSearchParams();
    form.set("apikey", key);

    // ✅ 영어 시험 고정(정확도/안정성)
    form.set("language", "eng");

    form.set("isOverlayRequired", "false");
    form.set("detectOrientation", "true");
    form.set("scale", "true");
    form.set("OCREngine", "2");

    // OCR.Space는 이 형식 권장
    form.set("base64Image", "data:image/jpeg;base64," + base64);

    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { "content-type":"application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const data = await resp.json().catch(()=>null);
    if (!resp.ok || !data) {
      return json(200, { ok:false, error:"OCR.Space upstream error", detail: data || `HTTP ${resp.status}` });
    }

    if (data.IsErroredOnProcessing) {
      return json(200, { ok:false, error:"OCR.Space processing error", detail: data.ErrorMessage || data.ErrorDetails || "" });
    }

    const text = String(data?.ParsedResults?.[0]?.ParsedText || "").trim();

    // OCR.Space가 평균 conf를 안정적으로 제공하지 않아 길이 기반 휴리스틱
    const conf = Math.max(0, Math.min(100, Math.round((text.length / 2600) * 100)));

    return json(200, { ok:true, text, conf });
  } catch (e) {
    return json(200, { ok:false, error:String(e?.message || e) });
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store",
    },
    body: JSON.stringify(obj),
  };
}

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}
