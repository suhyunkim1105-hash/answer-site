// netlify/functions/ocr.js
// OCR.Space(PRO) 호출: env 엔드포인트 사용(apipro1/apipro2) + 재시도 + 타임아웃 + 원문(raw) 일부 반환
// 기대 입력: { image: "data:image/jpeg;base64,...", page: 1 }

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

// "api-pro1.ocr.space" 같은 오타(하이픈) 자동 교정 → "apipro1.ocr.space"
function normalizeEndpoint(url) {
  if (!url) return "";
  let u = String(url).trim();
  u = u.replace(/:\/\/api-pro(\d)\./, "://apipro$1.");
  return u;
}

function getEndpoints() {
  const primary = normalizeEndpoint(process.env.OCR_SPACE_API_ENDPOINT) || "https://apipro1.ocr.space/parse/image";
  const backup =
    normalizeEndpoint(process.env.OCR_SPACE_API_ENDPOINT_BACKUP) || "https://apipro2.ocr.space/parse/image";

  // 중복 제거
  const arr = [primary, backup].filter(Boolean);
  return arr.filter((v, i) => arr.indexOf(v) === i);
}

function getTimeoutMs() {
  const n = Number(process.env.OCR_SPACE_TIMEOUT_MS || 30000);
  return Number.isFinite(n) && n >= 5000 ? n : 30000;
}

// 대충 문항번호 패턴 카운트(hits)
function countQuestionPatterns(text) {
  if (!text) return 0;
  const m = text.match(/\b(\d{1,2})\b[.)\s]/g);
  return m ? m.length : 0;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });

    const apiKey = (process.env.OCR_SPACE_API_KEY || "").trim();
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
    const image = (body.image || body.dataUrl || "").toString();

    if (!image || !image.startsWith("data:image/")) {
      return json(400, {
        ok: false,
        error: "Missing image (expected data URL in JSON body: { image: 'data:image/...base64,...' })",
      });
    }

    const timeoutMs = getTimeoutMs();
    const endpoints = getEndpoints();

    // OCR.Space는 base64Image에 dataURL 전체를 받음
    const payload = new URLSearchParams();
    payload.set("apikey", apiKey);
    payload.set("language", "eng");
    payload.set("isOverlayRequired", "false");
    payload.set("OCREngine", "2");
    payload.set("scale", "true");
    payload.set("detectOrientation", "true");
    payload.set("base64Image", image);

    const options = {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: payload.toString(),
    };

    const maxTriesPerEndpoint = 2; // 엔드포인트별 재시도
    let lastRaw = "";
    let lastErr = null;
    let used = "";

    for (const ep of endpoints) {
      used = ep;

      for (let t = 0; t < maxTriesPerEndpoint; t++) {
        try {
          const res = await fetchWithTimeout(ep, options, timeoutMs);
          lastRaw = await res.text().catch(() => "");

          let data = null;
          try {
            data = JSON.parse(lastRaw);
          } catch {
            data = null;
          }

          // HTTP 에러
          if (!res.ok) {
            // PRO 키인데 무료 엔드포인트로 치면 여기서 403 + "The API key is invalid"가 자주 뜸
            lastErr = `OCR.Space HTTP ${res.status}${lastRaw ? " / " + String(lastRaw).slice(0, 200) : ""}`;
            if (t < maxTriesPerEndpoint - 1) await sleep(350 * (t + 1));
            continue;
          }

          // JSON 파싱 실패
          if (!data) {
            lastErr = "OCR.Space returned non-JSON";
            if (t < maxTriesPerEndpoint - 1) await sleep(350 * (t + 1));
            continue;
          }

          // OCR 내부 실패
          if (data.IsErroredOnProcessing) {
            const msg = (data.ErrorMessage && data.ErrorMessage.join(" | ")) || data.ErrorDetails || "OCR processing error";
            lastErr = msg;
            if (t < maxTriesPerEndpoint - 1) await sleep(350 * (t + 1));
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
              endpointUsed: ep,
              ocrSpace: {
                exitCode: data.OCRExitCode,
                processingTimeInMilliseconds: data.ProcessingTimeInMilliseconds,
              },
            },
          });
        } catch (e) {
          lastErr = e?.name === "AbortError" ? `timeout(${timeoutMs}ms)` : (e?.message || String(e));
          // DNS 오류(ENOTFOUND) 같은 원인도 message에 들어옴
          if (t < maxTriesPerEndpoint - 1) await sleep(350 * (t + 1));
        }
      }
      // 다음 엔드포인트로 폴백
    }

    return json(502, {
      ok: false,
      error: "OCR.Space upstream error",
      detail: lastErr || "Unknown",
      raw: (lastRaw || "").slice(0, 1500),
      debug: { endpointUsed: used },
      hint:
        "1) OCR_SPACE_API_ENDPOINT는 https://apipro1.ocr.space/parse/image (하이픈 없음)\n" +
        "2) OCR_SPACE_API_ENDPOINT_BACKUP는 https://apipro2.ocr.space/parse/image\n" +
        "3) OCR_SPACE_API_KEY 정확히(공백/따옴표 없이)\n" +
        "4) Netlify에서 Clear cache and deploy",
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "Internal server error in ocr function",
      detail: String(err?.message || err),
    });
  }
};
