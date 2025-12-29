// netlify/functions/ocr.js
// OCR.Space 호출 + 실패 이유를 "프론트에 그대로" 반환 (Netlify 로그 UI가 안 떠도 원인 확인 가능)

export async function handler(event) {
  const json = (statusCode, obj) => ({
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST,OPTIONS",
    },
    body: JSON.stringify(obj),
  });

  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method Not Allowed" });

  const API_KEY = process.env.OCR_SPACE_API_KEY; // ✅ Netlify env 이름과 동일해야 함

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Bad JSON body" });
  }

  const imageDataUrl = body.imageDataUrl;

  if (!API_KEY) {
    return json(500, { ok: false, error: "Missing OCR_SPACE_API_KEY env" });
  }
  if (!imageDataUrl || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
    return json(400, { ok: false, error: "Missing imageDataUrl" });
  }

  // 대략 용량(너무 크면 413/timeout 가능)
  const approxBytes = Math.floor((imageDataUrl.length * 3) / 4);

  const endpoint = "https://api.ocr.space/parse/image";
  const params = new URLSearchParams();
  params.set("apikey", API_KEY);
  params.set("language", "eng");
  params.set("isOverlayRequired", "false");
  params.set("OCREngine", "2");
  params.set("scale", "true");
  params.set("detectOrientation", "true");
  params.set("base64Image", imageDataUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: controller.signal,
    });

    const status = resp.status;
    const text = await resp.text();

    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      return json(502, { ok: false, error: "OCR response not JSON", status, approxBytes, head: text.slice(0, 220) });
    }

    if (!resp.ok) {
      return json(502, { ok: false, error: "OCR HTTP error", status, approxBytes, detail: data });
    }

    if (data.IsErroredOnProcessing) {
      return json(200, {
        ok: false,
        error: "OCR processing error",
        status: 200,
        approxBytes,
        detail: data.ErrorMessage || data.ErrorDetails || data,
      });
    }

    const parsed = data?.ParsedResults?.[0]?.ParsedText || "";
    const out = String(parsed).trim();

    // conf 추정(영문 페이지 기준): 알파벳 비율
    const nonSpace = out.replace(/\s+/g, "");
    const letters = (nonSpace.match(/[A-Za-z]/g) || []).length;
    const conf = nonSpace.length ? Math.max(0, Math.min(1, letters / nonSpace.length)) : 0;

    return json(200, { ok: true, text: out, conf, approxBytes });
  } catch (e) {
    const msg = String(e && (e.message || e));
    return json(502, { ok: false, error: "OCR fetch exception", approxBytes, detail: msg });
  } finally {
    clearTimeout(timeout);
  }
}

