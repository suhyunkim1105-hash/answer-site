// netlify/functions/ocr.js
// OCR.Space 호출 + 실패 이유를 반드시 console.error로 남김 + 프론트에 status/detail 반환

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

  const API_KEY = process.env.OCR_SPACE_API_KEY; // ✅ 너가 Netlify에 설정한 이름과 동일해야 함

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    console.error("OCR_FAIL: bad JSON body", e);
    return json(400, { ok: false, error: "Bad JSON body" });
  }

  const imageDataUrl = body.imageDataUrl;
  if (!API_KEY) {
    console.error("OCR_FAIL: missing OCR_SPACE_API_KEY env");
    return json(500, { ok: false, error: "Missing OCR_SPACE_API_KEY env" });
  }
  if (!imageDataUrl || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
    console.error("OCR_FAIL: missing imageDataUrl", {
      hasBody: !!event.body,
      keys: Object.keys(body || {}),
      imageType: typeof imageDataUrl,
    });
    return json(400, { ok: false, error: "Missing imageDataUrl" });
  }

  // 대략 용량 로그(너무 크면 413/timeout 원인)
  const approxBytes = Math.floor((imageDataUrl.length * 3) / 4);
  console.log("OCR_REQ", { approxBytes });

  // OCR.Space API
  const endpoint = "https://api.ocr.space/parse/image";

  const params = new URLSearchParams();
  params.set("apikey", API_KEY);
  params.set("language", "eng");          // ✅ 성대/홍대 편입영어라서 기본 eng
  params.set("isOverlayRequired", "false");
  params.set("OCREngine", "2");           // 엔진 2가 보통 더 낫다고 알려져 있음(환경 따라 다름)
  params.set("scale", "true");
  params.set("detectOrientation", "true");
  params.set("base64Image", imageDataUrl); // data:image/jpeg;base64,... 그대로

  // 타임아웃
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  let respText = "";
  let status = 0;

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: controller.signal,
    });

    status = resp.status;
    respText = await resp.text();

    // OCR.Space는 200이어도 내부 에러를 JSON에 담아줄 수 있음
    let data = null;
    try {
      data = JSON.parse(respText);
    } catch (e) {
      console.error("OCR_FAIL: non-JSON response", { status, head: respText.slice(0, 200) });
      return json(502, { ok: false, error: "OCR response not JSON", status, detail: respText.slice(0, 300) });
    }

    if (!resp.ok) {
      console.error("OCR_FAIL: HTTP not ok", { status, data });
      return json(502, { ok: false, error: "OCR HTTP error", status, detail: data });
    }

    if (data.IsErroredOnProcessing) {
      console.error("OCR_FAIL: IsErroredOnProcessing", data.ErrorMessage || data.ErrorDetails || data);
      return json(200, {
        ok: false,
        error: "OCR processing error",
        status: 200,
        detail: data.ErrorMessage || data.ErrorDetails || data,
      });
    }

    const parsed = data?.ParsedResults?.[0]?.ParsedText || "";
    const text = String(parsed).trim();

    // 간단 conf 추정(영문 시험지 기준): 글자 중 알파벳 비율이 낮으면 품질이 나쁘다고 판단
    const nonSpace = text.replace(/\s+/g, "");
    const letters = (nonSpace.match(/[A-Za-z]/g) || []).length;
    const conf = nonSpace.length ? Math.max(0, Math.min(1, letters / nonSpace.length)) : 0;

    return json(200, { ok: true, text, conf, approxBytes });
  } catch (e) {
    const msg = String(e && (e.message || e));
    console.error("OCR_FAIL: fetch exception", { status, msg, head: respText.slice(0, 200) });
    return json(502, { ok: false, error: "OCR fetch exception", status, detail: msg });
  } finally {
    clearTimeout(timeout);
  }
}
