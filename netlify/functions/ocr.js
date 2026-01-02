// netlify/functions/ocr.js
// 입력: { page, image: "data:image/jpeg;base64,..." }
// 출력: { ok, text, patternCount, error?, detail? }

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

function dataUrlToBuffer(dataUrl) {
  const i = dataUrl.indexOf(",");
  if (i < 0) return null;
  const meta = dataUrl.slice(0, i);
  const b64 = dataUrl.slice(i + 1);
  const m = meta.match(/^data:(.+);base64$/i);
  const mime = m ? m[1] : "image/jpeg";
  const buf = Buffer.from(b64, "base64");
  return { mime, buf };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method Not Allowed" }) };
    }

    const body = JSON.parse(event.body || "{}");
    const page = Number(body.page || 1);
    const image = body.image;

    if (!image || typeof image !== "string" || !image.startsWith("data:image/")) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "BadRequest: image(dataURL) required" }) };
    }

    const endpoint = process.env.OCR_SPACE_API_ENDPOINT || "https://apipro1.ocr.space/parse/image";
    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: "ServerMisconfig: OCR key missing" }) };
    }

    const conv = dataUrlToBuffer(image);
    if (!conv) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "BadRequest: invalid dataURL" }) };
    }

    // ★중요: x-www-form-urlencoded로 base64를 보내면 퍼센트 인코딩으로 용량/시간 폭발함.
    // multipart로 파일 업로드가 훨씬 안정적.
    const fd = new FormData();
    fd.set("apikey", apiKey);
    fd.set("language", "eng");
    fd.set("isOverlayRequired", "false");
    fd.set("detectOrientation", "true");
    fd.set("scale", "true");
    fd.set("OCREngine", "2");
    fd.set("isTable", "false");

    const blob = new Blob([conv.buf], { type: conv.mime });
    fd.set("file", blob, `page-${page}.jpg`);

    const resp = await fetch(endpoint, { method: "POST", body: fd });
    const data = await resp.json().catch(() => null);

    if (!resp.ok || !data) {
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: "OCR upstream failed", detail: `HTTP ${resp.status}` }) };
    }

    if (data.IsErroredOnProcessing) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: false,
          error: "OCRSpaceError",
          detail: (data.ErrorMessage && data.ErrorMessage[0]) || data.ErrorMessage || "Unknown"
        })
      };
    }

    const parsed = (data.ParsedResults && data.ParsedResults[0] && data.ParsedResults[0].ParsedText) || "";
    const text = normalizeText(parsed);
    const patternCount = countQuestionPatterns(text);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, text, patternCount })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "ServerError", detail: e?.message || String(e) }) };
  }
};

