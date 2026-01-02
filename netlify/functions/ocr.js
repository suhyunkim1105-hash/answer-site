// netlify/functions/ocr.js
// OCR.Space 호출 (PRO 엔드포인트 지원)
// ✅ JSON으로 dataURL(base64) 받아서 OCR.Space에 base64Image로 전달

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

    // ✅ PRO 엔드포인트 기본값을 api-pro1로 둠 (너는 PRO 키 사용중)
    const endpoint = (process.env.OCR_SPACE_API_ENDPOINT || "https://api-pro1.ocr.space/parse/image").trim();
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

    const maxTries = 3;
    let lastErr = null;
    let lastRaw = "";

    for (let i = 0; i < maxTries; i++) {
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
        try { data = JSON.parse(lastRaw); } catch { /* ignore */ }

        // ✅ 403에서 가장 흔한 실수: PRO 키인데 무료 endpoint를 호출
        if (res.status === 403) {
          const raw = (lastRaw || "").slice(0, 200);
          return json(403, {
            ok: false,
            error: "OCR.Space upstream error",
            detail: "OCR.Space HTTP 403 (API key invalid or forbidden)",
            raw,
            hint:
              "1) PRO 키면 endpoint가 반드시 api-pro1/api-pro2 여야 함. " +
              "2) Netlify env OCR_SPACE_API_ENDPOINT 확인. " +
              "3) OCR_SPACE_API_KEY 값에 공백/줄바꿈 없는지 확인 후 재배포.",
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
        lastErr = (e && e.message) ? e.message : String(e);
        if (i < maxTries - 1) await sleep(350 * (i + 1));
      }
    }

    return json(502, {
      ok: false,
      error: "OCR.Space upstream error",
      detail: lastErr || "Unknown",
      raw: (lastRaw || "").slice(0, 1500),
      debug: { endpointUsed: endpoint },
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
