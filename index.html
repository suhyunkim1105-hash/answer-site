// netlify/functions/ocr.js
// 입력: { image: "data:image/jpeg;base64,...", pageIndex?, shot?, part?, mode? }
// 출력:
//   성공: { ok:true, text:"...", conf:number }
//   실패: { ok:false, error:"...", detail? }

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const body = safeJson(event.body);
    const image = typeof body?.image === "string" ? body.image.trim() : "";

    if (!image) {
      return json(400, { ok: false, error: "Missing image" });
    }

    // ---- API 키 읽기 (여러 이름 지원) ----
    let apiKey =
      process.env.OCR_SPACE_API_KEY ||
      process.env.OCRSPACE_API_KEY ||
      process.env.OCR_API_KEY ||
      "";

    apiKey = String(apiKey || "").trim();
    if (!apiKey) {
      return json(500, { ok: false, error: "Missing OCR_SPACE_API_KEY env var" });
    }

    // ---- base64Image 형태로 정리 ----
    let base64Payload = image;
    const m = image.match(/^data:image\/[a-zA-Z0-9+]+;base64,(.+)$/);
    if (m && m[1]) {
      // OCR.Space는 "data:image/jpeg;base64,..." 전체를 받아도 되고
      // 순수 base64만 받아도 되는데, 여기선 전체 prefix 포함 형식으로 보냄.
      base64Payload = "data:image/jpeg;base64," + m[1];
    }

    // ---- OCR.Space 호출 ----
    const form = new URLSearchParams();
    form.append("apikey", apiKey);
    form.append("base64Image", base64Payload);
    // 성균관대/홍익대 영어 기준
    form.append("language", "eng");
    form.append("isOverlayRequired", "false");
    form.append("detectOrientation", "true");
    form.append("scale", "true");
    form.append("OCREngine", "2"); // PRO 권장 엔진

    const controller = new AbortController();
    const timeoutMs = Number(process.env.OCR_SPACE_TIMEOUT_MS || 25000);
    const t = setTimeout(() => controller.abort(), timeoutMs);

    let resp;
    try {
      resp = await fetch("https://api.ocr.space/parse/image", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(t);
      return json(200, {
        ok: false,
        error: "OCR.Space fetch failed",
        detail: String(e?.message || e),
      });
    }
    clearTimeout(t);

    const data = await resp.json().catch(() => ({}));

    // HTTP 에러
    if (!resp.ok) {
      return json(200, {
        ok: false,
        error: "OCR.Space HTTP error",
        detail: data,
      });
    }

    // OCR.Space 포맷 검사
    if (data?.IsErroredOnProcessing) {
      // 여기서 invalid key, daily limit, etc 전부 걸린다.
      const detail =
        (Array.isArray(data.ErrorMessage) && data.ErrorMessage.join(" / ")) ||
        data.ErrorMessage ||
        data.ErrorDetails ||
        "Unknown OCR error";
      return json(200, {
        ok: false,
        error: "OCR.Space upstream error",
        detail,
      });
    }

    const results = Array.isArray(data?.ParsedResults)
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
    const meanConf = Number(results[0].MeanConfidence || data.MeanConfidence || 0);

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

// 공통 유틸
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
  } catch (_) {
    return {};
  }
}
