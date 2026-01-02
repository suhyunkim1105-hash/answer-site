// netlify/functions/ocr.js
// 입력: { page, image: "data:image/jpeg;base64,..." }
// 출력: { ok, text, conf, patternCount }

const fetch = globalThis.fetch;

function normalizeText(s) {
  if (!s) return "";
  return String(s)
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐-‒–—]/g, "-")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countQuestionPatterns(text) {
  // 최소 규칙: 줄 시작의 "13." / "13 13." / "16.16." 류만 카운트
  const t = "\n" + text;
  const re = /(?:\n)\s*(\d{1,2})\s*(?:[.\)]\s*(?:\1\s*[.\)])?)?/g;
  let m, c = 0;
  const seen = new Set();
  while ((m = re.exec(t))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 50 && !seen.has(n)) {
      seen.add(n);
      c++;
    }
  }
  return c;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method Not Allowed" }) };
    }

    const body = JSON.parse(event.body || "{}");
    const image = body.image;
    if (!image || typeof image !== "string" || !image.startsWith("data:image/")) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "BadRequest: image(dataURL) required" }) };
    }

    const endpoint = process.env.OCR_SPACE_API_ENDPOINT || "https://apipro1.ocr.space/parse/image";
    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: "ServerMisconfig: OCR key missing" }) };
    }

    // OCR.Space는 base64Image로 dataURL 그대로 받음
    const form = new URLSearchParams();
    form.set("apikey", apiKey);
    form.set("base64Image", image);
    form.set("language", "eng");
    form.set("isOverlayRequired", "false");
    form.set("detectOrientation", "true");
    form.set("scale", "true");            // 중요: 작은 글자 확대 보정
    form.set("OCREngine", "2");           // 엔진 2가 대체로 더 잘 뽑힘
    form.set("isTable", "false");

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: "OCR upstream failed" }) };
    }

    if (data.IsErroredOnProcessing) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: false,
          error: "OCRSpaceError",
          detail: (data.ErrorMessage && data.ErrorMessage[0]) || data.ErrorMessage || data.ProcessingTimeInMilliseconds || "Unknown"
        })
      };
    }

    const parsed = (data.ParsedResults && data.ParsedResults[0] && data.ParsedResults[0].ParsedText) || "";
    const text = normalizeText(parsed);

    // OCR.Space 신뢰도는 구조가 일정치 않아서 최소로만
    const patternCount = countQuestionPatterns(text);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        text,
        conf: null,
        patternCount
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "ServerError", detail: e?.message || String(e) }) };
  }
};

