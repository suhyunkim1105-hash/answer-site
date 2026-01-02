// netlify/functions/ocr.js
// OCR.Space(PRO) 호출 + endpoint 자동 폴백 + 업스트림 에러 원문 최대한 유지
// 입력: JSON { page, image: "data:image/...;base64,..." }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page !== undefined ? body.page : 1;
    const image = String(body.image || body.dataUrl || "");

    if (!image || !image.startsWith("data:image/")) {
      return json(400, {
        ok: false,
        error: "Missing image (expected data URL: { image: 'data:image/...;base64,...' })",
      });
    }

    // ✅ endpoint: primary/backup 둘 다 지원 (네가 이미 세팅한 값 그대로 사용 가능)
    const primary = String(process.env.OCR_SPACE_API_ENDPOINT || "").trim();
    const backup = String(process.env.OCR_SPACE_API_ENDPOINT_BACKUP || "").trim();

    // fallback 기본값 (혹시 env가 비어있어도 동작하도록)
    const endpoints = [
      primary || "https://apipro1.ocr.space/parse/image",
      backup || "https://apipro2.ocr.space/parse/image",
    ].filter(Boolean);

    const timeoutMs = Number(process.env.OCR_SPACE_TIMEOUT_MS || 30000);

    // OCR.Space payload
    const payload = new URLSearchParams();
    payload.set("apikey", apiKey);
    payload.set("language", "eng");
    payload.set("isOverlayRequired", "false");
    payload.set("OCREngine", "2");
    payload.set("scale", "true");
    payload.set("detectOrientation", "true");
    payload.set("base64Image", image);

    const maxTries = 4; // endpoint*2 + retry
    let lastErr = null;
    let lastRaw = "";
    let lastEndpoint = endpoints[0];

    for (let i = 0; i < maxTries; i++) {
      const endpoint = endpoints[i % endpoints.length];
      lastEndpoint = endpoint;

      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: payload.toString(),
          signal: controller.signal,
        }).finally(() => clearTimeout(t));

        lastRaw = await res.text().catch(() => "");
        let data = null;
        try {
          data = JSON.parse(lastRaw);
        } catch {
          // ignore
        }

        if (!res.ok) {
          // 403/429/5xx 등
          lastErr = `OCR.Space HTTP ${res.status}`;
          if (i < maxTries - 1) await sleep(250 * (i + 1));
          continue;
        }

        if (!data) {
          lastErr = "OCR.Space returned non-JSON";
          if (i < maxTries - 1) await sleep(250 * (i + 1));
          continue;
        }

        if (data.IsErroredOnProcessing) {
          const msg =
            (Array.isArray(data.ErrorMessage) && data.ErrorMessage.join(" | ")) ||
            data.ErrorDetails ||
            "OCR.Space processing error";
          lastErr = msg;
          if (i < maxTries - 1) await sleep(250 * (i + 1));
          continue;
        }

        const parsed = (data.ParsedResults && data.ParsedResults[0]) || null;
        const text = parsed && parsed.ParsedText ? String(parsed.ParsedText) : "";

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
        const isAbort = e && (e.name === "AbortError" || String(e).includes("AbortError"));
        lastErr = isAbort ? `timeout after ${timeoutMs}ms` : (e?.message || String(e));
        if (i < maxTries - 1) await sleep(250 * (i + 1));
      }
    }

    return json(502, {
      ok: false,
      error: "OCR.Space upstream error",
      detail: lastErr || "Unknown",
      raw: (lastRaw || "").slice(0, 1500),
      debug: { endpointUsed: lastEndpoint },
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "Internal server error in ocr function",
      detail: String(err?.message || err),
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
  const m = text.match(/\b(0?[1-9]|1[0-9]|20)\b\s*[.)]/g);
  return m ? m.length : 0;
}

