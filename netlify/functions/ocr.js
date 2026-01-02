// netlify/functions/ocr.js
// OCR.Space(PRO) 호출 (apipro1/apipro2)
// - env에 예전 값(api-pro1/api-pro2)이 들어가 있어도 자동 보정
// - primary + backup 자동 폴백
// - fetch 실패 시 원인(cause)까지 내려줌

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeEndpoint(url) {
  if (!url) return "";
  let u = String(url).trim();

  // ✅ 잘못 쓰기 교정: api-pro1/2 -> apipro1/2
  u = u.replace("https://api-pro1.ocr.space/parse/image", "https://apipro1.ocr.space/parse/image");
  u = u.replace("https://api-pro2.ocr.space/parse/image", "https://apipro2.ocr.space/parse/image");

  // 혹시 parse/image 빠진 경우 보정
  if (u === "https://apipro1.ocr.space") u = "https://apipro1.ocr.space/parse/image";
  if (u === "https://apipro2.ocr.space") u = "https://apipro2.ocr.space/parse/image";

  return u;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = (process.env.OCR_SPACE_API_KEY || "").trim();
    if (!apiKey) {
      return json(500, { ok: false, error: "OCR_SPACE_API_KEY is not set on the server" });
    }

    const primaryEnv = normalizeEndpoint(process.env.OCR_SPACE_API_ENDPOINT);
    const backupEnv = normalizeEndpoint(process.env.OCR_SPACE_API_ENDPOINT_BACKUP);

    const primaryDefault = "https://apipro1.ocr.space/parse/image";
    const backupDefault = "https://apipro2.ocr.space/parse/image";

    const endpoints = Array.from(
      new Set([primaryEnv || primaryDefault, backupEnv || backupDefault].filter(Boolean))
    );

    const timeoutMs = Number(process.env.OCR_SPACE_TIMEOUT_MS || 30000);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page !== undefined ? body.page : 1;
    const image = (body.image || body.dataUrl || "").toString();

    if (!image || !image.startsWith("data:image/")) {
      return json(400, {
        ok: false,
        error: "Missing image (expected data URL in JSON body: { image: 'data:image/...base64,...' })",
      });
    }

    const payload = new URLSearchParams();
    payload.set("apikey", apiKey);
    payload.set("language", "eng");
    payload.set("isOverlayRequired", "false");
    payload.set("OCREngine", "2");
    payload.set("scale", "true");
    payload.set("detectOrientation", "true");
    payload.set("base64Image", image);

    const maxTries = 4; // 2 endpoints * 2 rounds
    let lastErr = null;
    let lastRaw = "";
    let lastEndpoint = endpoints[0];

    for (let i = 0; i < maxTries; i++) {
      const endpoint = endpoints[i % endpoints.length];
      lastEndpoint = endpoint;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: payload.toString(),
          signal: controller.signal,
        });

        clearTimeout(timer);

        lastRaw = await res.text().catch(() => "");
        let data = null;
        try { data = JSON.parse(lastRaw); } catch {}

        if (res.status === 403) {
          return json(403, {
            ok: false,
            error: "OCR.Space upstream error",
            detail: "OCR.Space HTTP 403 (API key invalid or forbidden)",
            raw: (lastRaw || "").slice(0, 300),
            hint:
              "PRO 키면 endpoint는 apipro1/apipro2 여야 함. " +
              "env OCR_SPACE_API_ENDPOINT / OCR_SPACE_API_ENDPOINT_BACKUP 확인. " +
              "키 값에 공백/줄바꿈 없는지 확인.",
            debug: { endpointUsed: endpoint },
          });
        }

        if (!res.ok) {
          lastErr = `OCR.Space HTTP ${res.status}`;
          if (i < maxTries - 1) await sleep(350 * (i + 1));
          continue;
        }

        if (!data) {
          lastErr = "OCR.Space returned non-JSON";
          if (i < maxTries - 1) await sleep(350 * (i + 1));
          continue;
        }

        if (data.IsErroredOnProcessing) {
          const msg = (data.ErrorMessage && data.ErrorMessage.join(" | ")) || data.ErrorDetails || "OCR.Space processing error";
          lastErr = msg;
          if (i < maxTries - 1) await sleep(350 * (i + 1));
          continue;
        }

        const parsed = (data.ParsedResults && data.ParsedResults[0]) || null;
        const text = (parsed && parsed.ParsedText) ? String(parsed.ParsedText) : "";

        return json(200, {
          ok: true,
          text,
          conf: 0,
          hits: countQuestionPatterns(text),
          debug: {
            page,
            endpointUsed: endpoint,
            ocrSpace: {
              exitCode: data.OCRExitCode,
              processingTimeInMilliseconds: data.ProcessingTimeInMilliseconds,
            },
          },
        });
      } catch (e) {
        clearTimeout(timer);
        const cause = e && e.cause ? e.cause : null;
        lastErr = {
          message: e?.message || String(e),
          name: e?.name || "",
          cause: cause ? {
            code: cause.code,
            errno: cause.errno,
            syscall: cause.syscall,
            hostname: cause.hostname,
          } : null,
        };
        if (i < maxTries - 1) await sleep(350 * (i + 1));
      }
    }

    return json(502, {
      ok: false,
      error: "OCR.Space upstream error",
      detail: "fetch failed",
      debug: { endpointUsed: lastEndpoint, lastErr },
      raw: (lastRaw || "").slice(0, 500),
      hint:
        "지금은 대부분 endpoint 오타/미반영(재배포 안됨) 때문. " +
        "env의 OCR_SPACE_API_ENDPOINT가 apipro1인지 확인하고 재배포.",
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "Internal server error in ocr function",
      detail: String(err && err.message ? err.message : err),
    });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function countQuestionPatterns(text) {
  if (!text) return 0;
  const m = text.match(/\b(\d{1,2})\b[.)\s]/g);
  return m ? m.length : 0;
}
