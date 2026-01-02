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

    const apiKey = process.env.OCR_SPACE_API_KEY;
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
    const image = (body.image || body.dataUrl || "").toString();

    if (!image || !image.startsWith("data:image/")) {
      return json(400, {
        ok: false,
        error: "Missing image (expected data URL in JSON body: { image: 'data:image/...base64,...' })",
      });
    }

    // OCR.Space는 base64Image 파라미터로 dataURL을 그대로 받음
    // 예: base64Image=data:image/jpeg;base64,/9j/4AAQ...
    const payload = new URLSearchParams();
    payload.set("apikey", apiKey);
    payload.set("language", "eng");
    payload.set("isOverlayRequired", "false");
    payload.set("OCREngine", "2");
    payload.set("scale", "true");
    payload.set("detectOrientation", "true");
    payload.set("base64Image", image);

    // ✅ 재시도(업스트림 일시 장애/레이트리밋 대응)
    const maxTries = 3;
    let lastErr = null;
    let lastRaw = "";

    for (let i = 0; i < maxTries; i++) {
      try {
        const res = await fetch("https://api.ocr.space/parse/image", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: payload.toString(),
        });

        lastRaw = await res.text().catch(() => "");
        let data = null;
        try { data = JSON.parse(lastRaw); } catch { /* ignore */ }

        // OCR.Space가 200을 주더라도 IsErroredOnProcessing으로 실패 표시하는 경우가 많음
        if (!res.ok) {
          lastErr = `OCR.Space HTTP ${res.status}`;
          // 다음 시도 전 백오프
          if (i < maxTries - 1) await sleep(350 * (i + 1));
          continue;
        }

        if (!data) {
          lastErr = "OCR.Space returned non-JSON";
          if (i < maxTries - 1) await sleep(350 * (i + 1));
          continue;
        }

        if (data.IsErroredOnProcessing) {
          // 대표적으로: quota 초과 / invalid key / service unavailable 등
          const msg = (data.ErrorMessage && data.ErrorMessage.join(" | ")) || data.ErrorDetails || "OCR.Space processing error";
          lastErr = msg;
          if (i < maxTries - 1) await sleep(350 * (i + 1));
          continue;
        }

        const parsed = (data.ParsedResults && data.ParsedResults[0]) || null;
        const text = (parsed && parsed.ParsedText) ? String(parsed.ParsedText) : "";

        // conf/hits는 네 UI 로그 형태 맞추려고 유지(없으면 0)
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

    // 여기로 왔다는 건 3번 다 실패
    return json(502, {
      ok: false,
      error: "OCR.Space upstream error",
      detail: lastErr || "Unknown",
      raw: (lastRaw || "").slice(0, 1500), // ✅ 원문 일부 내려서 Netlify 로그 없이도 파악 가능
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

// 대충 문항번호 패턴 카운트(너가 쓰던 hits 느낌 유지)
function countQuestionPatterns(text) {
  if (!text) return 0;
  const m = text.match(/\b(\d{1,2})\b[.)\s]/g);
  return m ? m.length : 0;
}
