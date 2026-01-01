// netlify/functions/ocr.js
// 입력: { image: "data:image/jpeg;base64,...", pageIndex?, shot?, part?, mode? }
// 출력 성공: { ok:true, text:"...", conf:number }
// 출력 실패: { ok:false, error:"...", detail? }

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const body = safeJson(event.body);
    const rawImage =
      typeof body?.image === "string" ? body.image.trim() : "";

    if (!rawImage) {
      return json(400, { ok: false, error: "Missing image" });
    }

    // --- API 키 읽기 (여러 이름 지원) ---
    let apiKey =
      process.env.OCR_SPACE_API_KEY ||
      process.env.OCRSPACE_API_KEY ||
      process.env.OCR_API_KEY ||
      "";

    apiKey = String(apiKey || "").trim();

    if (!apiKey) {
      return json(500, {
        ok: false,
        error: "Missing OCR_SPACE_API_KEY env var",
      });
    }

    // --- base64Image 형태 정리 ---
    let base64Payload = rawImage;
    const m = rawImage.match(/data:image\/[a-zA-Z0-9+]+;base64,(.+)$/);
    if (m && m[1]) {
      base64Payload = m[1];
    }

    // --- OCR.Space 요청 폼 구성 ---
    const form = new URLSearchParams();
    form.append("apikey", apiKey);           // 바디에도 apikey
    form.append("base64Image", base64Payload);
    form.append("language", "eng");
    form.append("isOverlayRequired", "false");
    form.append("detectOrientation", "true");
    form.append("scale", "true");
    form.append("OCREngine", "2");           // PRO 엔진2 사용

    const endpoint =
      (process.env.OCR_SPACE_ENDPOINT || "").trim() ||
      "https://api.ocr.space/parse/image";

    const controller = new AbortController();
    const timeoutMs = Number(process.env.OCR_SPACE_TIMEOUT_MS || 25000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          // 헤더에도 apikey 같이 넣기 (PRO/FREE 둘 다 호환)
          apikey: apiKey,
        },
        body: form.toString(),
      });
    } catch (e) {
      clearTimeout(timer);
      return json(200, {
        ok: false,
        error: "OCR.Space fetch failed",
        detail: String(e?.message || e),
      });
    }

    clearTimeout(timer);

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return json(200, {
        ok: false,
        error: "OCR.Space HTTP error",
        detail: data,
      });
    }

    // --- OCR.Space 쪽 에러 처리 ---
    if (data.IsErroredOnProcessing) {
      const detail =
        (Array.isArray(data.ErrorMessage) &&
          data.ErrorMessage.join(" / ")) ||
        data.ErrorMessage ||
        data.ErrorDetails ||
        "Unknown OCR error";

      return json(200, {
        ok: false,
        error: "OCR.Space upstream error",
        detail,
      });
    }

    const results = Array.isArray(data.ParsedResults)
      ? data.ParsedResults
      : [];

    if (!results.length || !results[0]?.ParsedText) {
      return json(200, {
        ok: false,
        error: "No text parsed",
        detail: data,
      });
    }

    const parsedText = String(results[0].ParsedText || "");
    const meanConf = Number(
      results[0].MeanConfidence || data.MeanConfidence || 0
    );

    return json(200, {
      ok: true,
      text: parsedText,
      conf: Number.isFinite(meanConf) ? meanConf : 0,
    });
  } catch (e) {
    const msg =
      e?.name === "AbortError"
        ? "OCR.Space timeout"
        : String(e?.message || e);
    return json(200, { ok: false, error: msg });
  }
}

// 공통 유틸 -----------------------------

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}
