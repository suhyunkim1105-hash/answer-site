// netlify/functions/ocr.js
// -------------------------
// 역할: OCR.Space PRO로 시험지 이미지(OCR) 돌려서 텍스트만 반환
// 입력(JSON): { image: "data:image/jpeg;base64,...", page?: number }
// 출력(JSON): { ok: true, page, text, conf?, hits? } 또는 { ok: false, error, detail? }
//
// 필요한 환경변수:
// - OCR_SPACE_API_KEY       (필수)
// - OCR_SPACE_API_ENDPOINT  (선택, 예: "https://apipro1.ocr.space/parse/image")

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) {
      return json(500, { ok: false, error: "OCR_SPACE_API_KEY is not set" });
    }

    const endpoint =
      process.env.OCR_SPACE_API_ENDPOINT ||
      "https://apipro1.ocr.space/parse/image";

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const image = body.image;
    if (!image || typeof image !== "string") {
      return json(400, { ok: false, error: "image(dataURL) is required" });
    }

    // OCR.Space API 호출
    // language: "auto"  → 한국어 + 영어 포함해서 자동 인식 (한양대 때처럼 한국어도 인식되도록)
    const form = new URLSearchParams();
    form.append("apikey", apiKey);
    form.append("language", "auto");
    form.append("isOverlayRequired", "false");
    form.append("OCREngine", "2");
    form.append("base64Image", image); // data:image/jpeg;base64,... 그대로 전달

    const res = await fetch(endpoint, {
      method: "POST",
      body: form,
    });

    let data;
    try {
      data = await res.json();
    } catch (e) {
      return json(502, {
        ok: false,
        error: "Invalid OCR API response",
        detail: String(e?.message || e),
      });
    }

    if (!res.ok) {
      return json(res.status, {
        ok: false,
        error: "HTTP error from OCR API",
        detail: data,
      });
    }

    if (data.IsErroredOnProcessing) {
      return json(500, {
        ok: false,
        error: "OCR API processing error",
        detail: data.ErrorMessage || data.ErrorDetails || null,
      });
    }

    const parsedResults = Array.isArray(data.ParsedResults)
      ? data.ParsedResults
      : [];

    const text = parsedResults
      .map((r) => r.ParsedText || "")
      .join("\n")
      .trim();

    // 평균 신뢰도(있으면)와 문항번호 패턴 수(옵션)
    const conf =
      parsedResults[0] && typeof parsedResults[0].MeanConfidenceLevel === "number"
        ? parsedResults[0].MeanConfidenceLevel
        : null;

    let hits = null;
    if (text) {
      const m = text.match(/\b\d{1,2}\s*[.)]/g);
      hits = m ? m.length : 0;
    }

    return json(200, {
      ok: true,
      page,
      text,
      conf,
      hits,
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "Unhandled error in ocr function",
      detail: String(e?.message || e),
    });
  }
};


