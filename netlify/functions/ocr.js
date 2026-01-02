// netlify/functions/ocr.js
// OCR.Space 호출. 업스트림 에러 원문을 최대한 그대로 내려줘서 원인 파악 가능하게 함.
// ✅ JSON으로 dataURL(base64) 받아서 OCR.Space에 base64Image로 전달 (multipart 파싱 불필요)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    // ✅ 공백/개행 섞여도 invalid 뜨는 경우 많아서 trim
    const apiKey = String(process.env.OCR_SPACE_API_KEY || "").trim();
    if (!apiKey) {
      return json(500, { ok: false, error: "OCR_SPACE_API_KEY is not set on the server" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page !== undefined ? body.page : 1;

    // 기대 입력: { image: "data:image/jpeg;base64,..." }
    const image = String(body.image || body.dataUrl || "").trim();

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
      try {
        const res = await fetch("https://api.ocr.space/parse/image", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: payload.toString(),
        });

        lastRaw = await res.text().catch(() => "");
        let data = null;
        try { data = JSON.parse(lastRaw); } catch { /* ignore */ }

        // ✅ 403이면 거의 항상 키 문제. 즉시 명확히 반환
        if (res.status === 403) {
          return json(502, {
            ok: false,
            error: "OCR.Space upstream error",
            detail: "OCR.Space HTTP 403 (API key invalid or forbidden)",
            raw: String(lastRaw || "").slice(0, 1500),
            hint: "Check Netlify env var OCR_SPACE_API_KEY (Key must be OCR_SPACE_API_KEY, Value must be the exact OCR.Space key, no spaces). Then redeploy.",
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
          const msg =
            (Array.isArray(data.ErrorMessage) && data.ErrorMessage.join(" | ")) ||
            data.ErrorDetails ||
            "OCR.Space processing error";
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
            ocrSpace: {
              exitCode: data.OCRExitCode,
              processingTimeInMilliseconds: data.ProcessingTimeInMilliseconds,
            },
          },
        });
      } catch (e) {
        lastErr = (e && e.message) ? e.message : String(e);
        if (i < maxTries - 1) await sleep(350 * (i + 1));
      }
    }

    return json(502, {
      ok: false,
      error: "OCR.Space upstream error",
      detail: lastErr || "Unknown",
      raw: String(lastRaw || "").slice(0, 1500),
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
