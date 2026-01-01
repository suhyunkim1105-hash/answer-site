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
    const image = typeof body?.image === "string" ? body.image.trim() : "";

    if (!image) {
      return json(400, { ok: false, error: "Missing image" });
    }

    // --- API 키 읽기 ---
    const envKey =
      process.env.OCR_SPACE_API_KEY ||
      process.env.OCRSPACE_API_KEY ||
      process.env.OCR_API_KEY ||
      "";
    const apiKey = String(envKey || "").trim();

    if (!apiKey) {
      return json(500, { ok: false, error: "Missing OCR_SPACE_API_KEY env var" });
    }

    // --- 엔드포인트 설정 ---
    const endpointEnv = process.env.OCR_SPACE_ENDPOINT || "";
    const endpoint = endpointEnv || "https://api.ocr.space/parse/image";

    // --- base64Image 형태 정리 ---
    // data:image/jpeg;base64,... 형식이 들어오면 prefix 떼고 본문만 보냄
    let base64Payload = image;
    const m = image.match(/^data:image\/[a-zA-Z0-9+]+;base64,(.+)$/);
    if (m && m[1]) {
      base64Payload = m[1];
    }

    // --- OCR.Space 호출 ---
    const form = new URLSearchParams();
    form.append("apikey", apiKey);
    form.append("isOverlayRequired", "false");
    form.append("language", "eng");
    form.append("OCREngine", "2"); // PRO 계정이면 2, Free면 1로 바꿔야 함
    form.append("detectOrientation", "true");
    form.append("scale", "true");
    form.append("base64Image", base64Payload);

    const controller = new AbortController();
    const timeoutMs = Number(process.env.OCR_SPACE_TIMEOUT_MS || 25000);
    const t = setTimeout(() => controller.abort(), timeoutMs);

    let resp;
    try {
      resp = await fetch(endpoint, {
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

    let data = {};
    try {
      data = await resp.json();
    } catch (_) {
      data = {};
    }

    if (!resp.ok) {
      return json(200, {
        ok: false,
        error: "OCR.Space HTTP error",
        detail: data,
      });
    }

    // --- OCR.Space에서 에러라고 판단한 경우 ---
    if (data.IsErroredOnProcessing) {
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

    const results = Array.isArray(data.ParsedResults)
      ? data.ParsedResults
      : [];
    if (!results.length || !results[0].ParsedText) {
      return json(200, {
        ok: false,
        error: "No text parsed",
        detail: data,
      });
    }

    const parsedText = String(results[0].ParsedText || "");
    const meanConf = Number(
      results[0].MeanConfidence ?? data.MeanConfidence ?? 0
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
