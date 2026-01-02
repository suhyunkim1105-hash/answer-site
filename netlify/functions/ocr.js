// netlify/functions/ocr.js
// OCR.Space PRO 호출 (apipro1/apipro2). JSON(dataURL)만 받음.
// - PRO 키는 반드시 apipro1/apipro2로 호출해야 함 (api.ocr.space 쓰면 403 invalid key)
// - endpoint는 env로 받되, 기본값도 PRO로 안전하게 설정
// - 타임아웃/재시도/폴백 포함

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    // ✅ env
    const apiKey =
      process.env.OCR_SPACE_API_KEY ||
      process.env.OCR_SPACE_APIKEY ||
      process.env.OCRSPACE_API_KEY;

    if (!apiKey) {
      return json(500, { ok: false, error: "OCR_SPACE_API_KEY is not set on the server" });
    }

    // ✅ PRO 기본값(안전)
    const endpointPrimary =
      process.env.OCR_SPACE_API_ENDPOINT ||
      "https://apipro1.ocr.space/parse/image";

    const endpointBackup =
      process.env.OCR_SPACE_API_ENDPOINT_BACKUP ||
      "https://apipro2.ocr.space/parse/image";

    const timeoutMs = Number(process.env.OCR_SPACE_TIMEOUT_MS || 30000);

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

    const payload = new URLSearchParams();
    payload.set("apikey", apiKey);
    payload.set("language", "eng");
    payload.set("isOverlayRequired", "false");
    payload.set("OCREngine", "2");
    payload.set("scale", "true");
    payload.set("detectOrientation", "true");
    payload.set("base64Image", image);

    // ✅ 시도 전략:
    // 1) primary 2~3번
    // 2) 실패하면 backup 1~2번
    const plan = [
      { url: endpointPrimary, tries: 3 },
      { url: endpointBackup, tries: 2 },
    ];

    let lastErr = null;
    let lastRaw = "";
    let lastEndpointUsed = "";

    for (const step of plan) {
      for (let i = 0; i < step.tries; i++) {
        lastEndpointUsed = step.url;
        try {
          const res = await fetchWithTimeout(
            step.url,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: payload.toString(),
            },
            timeoutMs
          );

          lastRaw = await res.text().catch(() => "");
          let data = null;
          try { data = JSON.parse(lastRaw); } catch { /* ignore */ }

          if (!res.ok) {
            // 403이면 거의 100% endpoint/키 문제
            lastErr = `OCR.Space HTTP ${res.status}${lastRaw ? " / " + lastRaw.slice(0, 200) : ""}`;
            if (i < step.tries - 1) await sleep(350 * (i + 1));
            continue;
          }

          if (!data) {
            lastErr = "OCR.Space returned non-JSON";
            if (i < step.tries - 1) await sleep(350 * (i + 1));
            continue;
          }

          if (data.IsErroredOnProcessing) {
            const msg =
              (Array.isArray(data.ErrorMessage) && data.ErrorMessage.join(" | ")) ||
              data.ErrorDetails ||
              "OCR.Space processing error";
            lastErr = msg;
            if (i < step.tries - 1) await sleep(350 * (i + 1));
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
              endpointUsed: step.url,
              ocrSpace: {
                exitCode: data.OCRExitCode,
                processingTimeInMilliseconds: data.ProcessingTimeInMilliseconds,
              },
            },
          });
        } catch (e) {
          // 네 로그에 ENOTFOUND가 떴던 케이스가 여기로 들어옴
          const detail = {
            message: e?.message || String(e),
            name: e?.name,
            cause: e?.cause,
          };
          lastErr = detail;
          if (i < step.tries - 1) await sleep(350 * (i + 1));
        }
      }
    }

    // 다 실패
    return json(502, {
      ok: false,
      error: "OCR.Space upstream error",
      detail: lastErr || "Unknown",
      raw: (lastRaw || "").slice(0, 1500),
      debug: { endpointUsed: lastEndpointUsed },
      hint:
        "1) PRO키면 endpoint가 반드시 https://apipro1.ocr.space/parse/image 또는 apipro2 여야 함(하이픈X). " +
        "2) Netlify env 적용은 재배포 필요. 3) 촬영 버튼 연타 금지.",
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "Internal server error in ocr function",
      detail: String(err?.message || err),
    });
  }
};
