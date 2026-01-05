// netlify/functions/ocr.js
// OCR.Space PRO 호출 함수
// - env: OCR_SPACE_API_KEY
// - env: OCR_SPACE_API_ENDPOINT (https://apipro1.ocr.space/parse/image 권장)
// - env: OCR_SPACE_API_ENDPOINT_BACKUP (https://apipro2.ocr.space/parse/image)
// - env: OCR_SPACE_TIMEOUT_MS (옵션, 기본 30000)

const API_KEY = process.env.OCR_SPACE_API_KEY;
const ENDPOINT =
  process.env.OCR_SPACE_API_ENDPOINT ||
  "https://apipro1.ocr.space/parse/image";
const ENDPOINT_BACKUP =
  process.env.OCR_SPACE_API_ENDPOINT_BACKUP ||
  "https://apipro2.ocr.space/parse/image";
const TIMEOUT_MS = parseInt(process.env.OCR_SPACE_TIMEOUT_MS || "30000", 10);

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(obj)
  };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("timeout")), ms);
    promise
      .then((v) => {
        clearTimeout(id);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(id);
        reject(e);
      });
  });
}

async function callOcrSpace(base64Image) {
  const formData = new URLSearchParams();
  formData.append("base64Image", base64Image);
  formData.append("language", "eng");
  formData.append("scale", "true");
  formData.append("OCREngine", "2");

  const headers = {
    apikey: API_KEY,
    "Content-Type": "application/x-www-form-urlencoded"
  };

  // 기본 엔드포인트 먼저, 실패하면 백업
  const endpoints = [ENDPOINT, ENDPOINT_BACKUP];

  for (const url of endpoints) {
    if (!url) continue;
    try {
      const resp = await withTimeout(
        fetch(url, {
          method: "POST",
          headers,
          body: formData.toString()
        }),
        TIMEOUT_MS
      );

      if (!resp.ok) continue;
      const data = await resp.json();
      if (
        !data.ParsedResults ||
        !Array.isArray(data.ParsedResults) ||
        !data.ParsedResults[0]
      ) {
        continue;
      }
      const parsedText = data.ParsedResults[0].ParsedText || "";
      return parsedText;
    } catch {
      // 다음 엔드포인트 시도
    }
  }

  throw new Error("OCR_SPACE_FAILED");
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod && event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    if (!API_KEY) {
      return json(500, {
        ok: false,
        error: "Missing OCR_SPACE_API_KEY"
      });
    }

    let body = {};
    try {
      body =
        typeof event.body === "string"
          ? JSON.parse(event.body || "{}")
          : event.body || {};
    } catch {
      body = {};
    }

    const base64Image = body.image || body.base64Image;
    if (!base64Image || typeof base64Image !== "string") {
      return json(400, { ok: false, error: "Missing base64 image" });
    }

    const text = await callOcrSpace(base64Image);

    return json(200, {
      ok: true,
      text
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: String(err && err.message ? err.message : err)
    });
  }
};

