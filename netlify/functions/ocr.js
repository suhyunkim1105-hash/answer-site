// netlify/functions/ocr.js
// OCR.Space 호출 (PRO 엔드포인트 지원 + 백업 폴백 + 타임아웃 + 재시도)
// 입력(JSON): { image: "data:image/jpeg;base64,...", page: 1 }
// 출력(JSON): { ok:true, text, conf:0, hits, debug:{...} }

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function countQuestionPatterns(text) {
  if (!text) return 0;
  const m = text.match(/\b(\d{1,2})\b[.)\s]/g);
  return m ? m.length : 0;
}

function getEndpoints() {
  // ✅ PRO 메일 기준 도메인: apipro1 / apipro2 (하이픈 없음)
  const primary = (process.env.OCR_SPACE_API_ENDPOINT || "").trim();
  const backup = (process.env.OCR_SPACE_API_ENDPOINT_BACKUP || "").trim();

  // 기본값(환경변수 없으면 무료 엔드포인트로 가지만, PRO 키면 403 날 수 있음)
  const defaults = ["https://api.ocr.space/parse/image"];

  const list = [];
  if (primary) list.push(primary);
  if (backup) list.push(backup);

  return list.length ? list : defaults;
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
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

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

    const endpoints = getEndpoints();
    const timeoutMs = Number(process.env.OCR_SPACE_TIMEOUT_MS || "30000");

    // OCR.Space는 base64Image에 dataURL 그대로 받음
    const makePayload = () => {
      const p = new URLSearchParams();
      p.set("apikey", apiKey);
      p.set("language", "eng");
      p.set("isOverlayRequired", "false");
      p.set("OCREngine", "2");
      p.set("scale", "true");
      p.set("detectOrientation", "true");
      p.set("base64Image", image);
      return p;
    };

    // ✅ 재시도(엔드포인트별) + 백오프
    const triesPerEndpoint = 2; // 각 엔드포인트에서 2번씩
    let lastErr = null;
    let lastRaw = "";
    let lastEndpoint = "";

    for (const endpoint of endpoints) {
      for (let i = 0; i < triesPerEndpoint; i++) {
        lastEndpoint = endpoint;
        try {
          const res = await fetchWithTimeout(
            endpoint,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: makePayload().toString(),
            },
            timeoutMs
          );

          lastRaw = await res.text().catch(() => "");
          let data = null;
          try {
            data = JSON.parse(lastRaw);
          } catch {
            data = null;
          }

          if (!res.ok) {
            lastErr = `OCR.Space HTTP ${res.status}`;
            // 403이면: 키/엔드포인트 불일치 가능성 큼 -> 다음 엔드포인트로 넘어감
            if (res.status === 403) break;
            if (i < triesPerEndpoint - 1) await sleep(350 * (i + 1));
            continue;
          }

          if (!data) {
            lastErr = "OCR.Space returned non-JSON";
            if (i < triesPerEndpoint - 1) await sleep(350 * (i + 1));
            continue;
          }

          if (data.IsErroredOnProcessing) {
            const msg =
              (Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(" | ") : "") ||
              data.ErrorDetails ||
              "OCR.Space processing error";
            lastErr = msg;

            // quota/invalid key류면 다음 엔드포인트로 넘어가는 게 빠름
            if (String(msg).toLowerCase().includes("invalid") || String(msg).toLowerCase().includes("key")) {
              break;
            }

            if (i < triesPerEndpoint - 1) await sleep(350 * (i + 1));
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
          // DNS/네트워크/타임아웃 포함
          lastErr = e && e.name === "AbortError" ? `timeout ${timeoutMs}ms` : (e?.message || String(e));
          if (i < triesPerEndpoint - 1) await sleep(350 * (i + 1));
        }
      }
      // 다음 엔드포인트로 폴백
    }

    return json(502, {
      ok: false,
      error: "OCR.Space upstream error",
      detail: lastErr || "Unknown",
      raw: (lastRaw || "").slice(0, 1500),
      debug: { endpointUsed: lastEndpoint, endpointsTried: endpoints },
      hint:
        "1) PRO면 OCR_SPACE_API_ENDPOINT는 https://apipro1.ocr.space/parse/image 여야 함(하이픈X). " +
        "2) OCR_SPACE_API_KEY 공백/줄바꿈 없는지 확인. 3) 변경 후 Netlify 재배포.",
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "Internal server error in ocr function",
      detail: String(err && err.message ? err.message : err),
    });
  }
};
