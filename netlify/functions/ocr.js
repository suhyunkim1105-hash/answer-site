// netlify/functions/ocr.js
// - Netlify Node 18: fetch 내장
// - OCR.Space PRO: apipro1 엔드포인트 사용
// - language는 단일 코드만 가능(E201 방지): kor 또는 eng
// - dual 모드: kor 1회 + eng 1회 실행 후 결과 합침

function json(headers, statusCode, obj) {
  return { statusCode, headers, body: JSON.stringify(obj) };
}

function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function normalizeLine(s) {
  return safeStr(s)
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function mergeTexts(t1, t2) {
  const seen = new Set();
  const out = [];

  const pushLines = (t) => {
    const lines = safeStr(t)
      .split(/\r?\n/)
      .map(normalizeLine)
      .filter(Boolean);

    for (const ln of lines) {
      const key = ln.replace(/\s/g, "").slice(0, 80);
      // 숫자/기호만 있는 짧은 줄도 살리기 위해 최소 길이 기준을 완화
      if (key.length < 3) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ln);
    }
  };

  pushLines(t1);
  pushLines(t2);

  return out.join("\n");
}

async function ocrOnce({ endpoint, apiKey, base64Part, language, engine, timeoutMs }) {
  const form = new URLSearchParams();
  form.set("apikey", apiKey);
  form.set("language", language); // 반드시 단일 코드
  form.set("isOverlayRequired", "false");
  form.set("scale", "true");
  form.set("detectOrientation", "true");
  form.set("OCREngine", String(engine || 2));
  // OCR.Space는 dataURL 전체 또는 base64Image 둘 다 허용하지만
  // 여기서는 규격 통일: data:image/jpeg;base64, 접두어 포함
  form.set("base64Image", "data:image/jpeg;base64," + base64Part);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 25000);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: controller.signal,
    });

    const raw = await resp.text().catch(() => "");

    if (!resp.ok) {
      return {
        ok: false,
        error: "OCR_HTTP_ERROR",
        status: resp.status,
        raw: raw.slice(0, 400),
      };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: "OCR_JSON_PARSE_ERROR", raw: raw.slice(0, 400) };
    }

    if (data.IsErroredOnProcessing) {
      const msg =
        (Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(" / ") : data.ErrorMessage) ||
        data.ErrorDetails ||
        "OCR.Space 처리 오류";
      return { ok: false, error: "OCR_PROCESSING_ERROR", message: msg };
    }

    const parsed = data.ParsedResults && data.ParsedResults[0] ? data.ParsedResults[0] : null;
    const text = parsed && parsed.ParsedText ? parsed.ParsedText : "";
    const conf = typeof parsed?.MeanConfidenceLevel === "number" ? parsed.MeanConfidenceLevel : 0;

    return { ok: true, text, conf };
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "OCR 요청 타임아웃" : String(e?.message || e);
    return { ok: false, error: "OCR_REQUEST_FAILED", message: msg };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return json(headers, 200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return json(headers, 405, { ok: false, error: "METHOD_NOT_ALLOWED", message: "POST only" });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(headers, 400, { ok: false, error: "INVALID_JSON" });
  }

  const pageIndex = typeof body.pageIndex === "number" ? body.pageIndex : null;

  // 프론트 호환: imageBase64(순수 base64) 또는 dataURL 둘 다 가능
  let imageBase64 = body.imageBase64 || body.imageDataUrl || body.dataUrl || body.image || "";

  if (!imageBase64 || typeof imageBase64 !== "string") {
    return json(headers, 200, {
      ok: false,
      error: "NO_IMAGE",
      message: "imageBase64 필드가 비어 있습니다.",
      pageIndex,
      receivedKeys: Object.keys(body),
    });
  }

  // data:image/...;base64, 포함이면 잘라서 base64만 남김
  let base64Part = imageBase64;
  const idx = imageBase64.indexOf("base64,");
  if (idx >= 0) base64Part = imageBase64.slice(idx + "base64,".length);

  if (!base64Part || base64Part.length < 50) {
    return json(headers, 200, {
      ok: false,
      error: "NO_IMAGE",
      message: "base64 데이터가 너무 짧습니다.",
      pageIndex,
    });
  }

  const apiKey = process.env.OCRSPACE_API_KEY;
  if (!apiKey) {
    return json(headers, 500, {
      ok: false,
      error: "NO_OCRSPACE_API_KEY",
      message: "Netlify 환경변수 OCRSPACE_API_KEY가 없습니다.",
      pageIndex,
    });
  }

  // PRO 엔드포인트
  const endpoint = "https://apipro1.ocr.space/parse/image";

  // 기본: dual(한국어+영어) 고정. 프론트에서 mode를 보내지 않아도 dual.
  const mode = (body.mode || "dual").toString(); // "kor" | "eng" | "dual"

  // 1) kor 시도
  const korRes = await ocrOnce({
    endpoint,
    apiKey,
    base64Part,
    language: "kor",
    engine: 2,
    timeoutMs: 25000,
  });

  // 2) eng 시도(dual/eng일 때)
  let engRes = { ok: false, text: "", conf: 0, error: "SKIP" };
  if (mode === "dual" || mode === "eng") {
    engRes = await ocrOnce({
      endpoint,
      apiKey,
      base64Part,
      language: "eng",
      engine: 2,
      timeoutMs: 25000,
    });
  }

  const korText = korRes.ok ? korRes.text : "";
  const engText = engRes.ok ? engRes.text : "";

  const merged = mode === "kor" ? korText : mode === "eng" ? engText : mergeTexts(korText, engText);

  const confs = [];
  if (korRes.ok) confs.push(korRes.conf || 0);
  if (engRes.ok) confs.push(engRes.conf || 0);
  const avgConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;

  if (!merged || !merged.trim()) {
    const msg =
      (korRes.ok ? "" : (korRes.message || korRes.raw || korRes.error || "")) ||
      (engRes.ok ? "" : (engRes.message || engRes.raw || engRes.error || "")) ||
      "OCR 결과가 비어있음";

    return json(headers, 200, {
      ok: false,
      error: "EMPTY_OCR_TEXT",
      message: msg ? String(msg).slice(0, 300) : "OCR 결과가 비어있음",
      pageIndex,
      detail: {
        kor: korRes.ok ? "ok" : (korRes.error || "fail"),
        eng: engRes.ok ? "ok" : (engRes.error || "fail"),
      },
    });
  }

  return json(headers, 200, {
    ok: true,
    text: merged,
    conf: avgConf,
    pageIndex,
    note: mode === "dual" ? "OCR(kor+eng) 성공" : `OCR(${mode}) 성공`,
  });
};

