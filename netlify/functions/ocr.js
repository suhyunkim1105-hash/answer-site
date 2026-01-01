// netlify/functions/ocr.js
// 입력:  { image:"data:image/jpeg;base64,...", pageIndex?, shot?, mode? }
// 출력:  성공 { ok:true, text:"...", conf:number, stopToken:boolean }
//       실패 { ok:false, error:"..." }

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const body = safeJson(event.body);
    const image = typeof body.image === "string" ? body.image.trim() : "";
    if (!image) {
      return json(400, { ok: false, error: "Missing image" });
    }

    // ── 🔑 API 키 여러 이름 모두 지원 (네가 설정한 CR_SPACE_API_KEY 포함) ──
    const apiKey =
      (process.env.OCR_SPACE_API_KEY || "").trim() ||
      (process.env.CR_SPACE_API_KEY || "").trim() ||
      (process.env.OCRSPACE_API_KEY || "").trim();

    if (!apiKey) {
      return json(500, { ok: false, error: "Missing OCR_SPACE_API_KEY / CR_SPACE_API_KEY env var" });
    }

    // dataURL 전체를 그대로 보내되, 혹시 base64 부분만 있으면 앞에 prefix를 붙여줌
    let base64Payload = image;
    const m = image.match(/^data:image\/[a-zA-Z0-9+]+;base64,(.+)$/);
    if (m && m[1]) {
      base64Payload = "data:image/jpeg;base64," + m[1];
    }

    const endpoint =
      (process.env.OCR_SPACE_ENDPOINT || "").trim() ||
      "https://api.ocr.space/parse/image";

    const form = new URLSearchParams();
    form.append("apikey", apiKey);
    form.append("base64Image", base64Payload);
    form.append("language", body.mode === "kor" ? "kor" : "eng"); // 일단 영어 위주
    form.append("isOverlayRequired", "false");
    form.append("detectOrientation", "true");
    form.append("scale", "true");
    form.append("OCREngine", "2"); // PRO 엔진 (무료 키면 무시됨)

    const timeoutMs = Number(process.env.OCR_SPACE_TIMEOUT_MS || 25000);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    let resp;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(t);
      return json(200, {
        ok: false,
        error: "OCR.Space fetch failed: " + String(e?.message || e),
      });
    }
    clearTimeout(t);

    let data = {};
    try {
      data = await resp.json();
    } catch (e) {
      return json(200, {
        ok: false,
        error: "OCR.Space HTTP error",
        detail: String(e),
      });
    }

    // ── OCR.Space 쪽에서 에러를 준 경우 (키 잘못, 플랜 문제, 포맷 오류 등) ──
    if (data.IsErroredOnProcessing) {
      const detail =
        (Array.isArray(data.ErrorMessage) && data.ErrorMessage.join(" / ")) ||
        data.ErrorMessage ||
        data.ErrorDetails ||
        "Unknown OCR error";
      return json(200, {
        ok: false,
        error: "OCR.Space upstream error: " + detail,
      });
    }

    const results = Array.isArray(data.ParsedResults) ? data.ParsedResults : [];
    if (!results.length || !results[0].ParsedText) {
      return json(200, { ok: false, error: "No text parsed", detail: data });
    }

    const parsedText = String(results[0].ParsedText || "");
    const meanConf = Number(results[0].MeanConfidence || data.OCRExitCode || 0);
    const stopToken = /XVRTH|XV RTH/i.test(parsedText);

    return json(200, {
      ok: true,
      text: parsedText,
      conf: Number.isFinite(meanConf) ? meanConf : 0,
      stopToken,
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
  } catch (_) {
    return {};
  }
}
