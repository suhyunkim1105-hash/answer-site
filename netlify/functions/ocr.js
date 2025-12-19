exports.handler = async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  };

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // POST 이외 메서드 거부
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: "POST only" }),
    };
  }

  try {
    const apiKey = process.env.OCRSPACE_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ ok: false, error: "OCRSPACE_API_KEY 환경변수가 없음" }),
      };
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: "JSON 파싱 실패" }),
      };
    }

    const imageDataUrl = body.imageDataUrl;
    const language = (body.language || "kor").toString();

    if (
      !imageDataUrl ||
      typeof imageDataUrl !== "string" ||
      !imageDataUrl.startsWith("data:image/")
    ) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          ok: false,
          error: "imageDataUrl(data:image/... base64) 필요",
        }),
      };
    }

    const form = new URLSearchParams();
    form.set("apikey", apiKey);
    form.set("language", language);
    form.set("isOverlayRequired", "false");
    form.set("detectOrientation", "true");
    form.set("scale", "true");
    // 🔴 여기만 변경: 엔진 2 → 1 (한글+영어 혼합용)
    form.set("OCREngine", "1");
    form.set("base64Image", imageDataUrl);

    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) {
      const t = await resp.text();
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          ok: false,
          error: "OCR.Space 응답이 JSON이 아님",
          detail: t.slice(0, 300),
        }),
      };
    }

    const data = await resp.json();

    if (data.IsErroredOnProcessing) {
      const errMsg =
        (Array.isArray(data.ErrorMessage)
          ? data.ErrorMessage.join(" / ")
          : data.ErrorMessage) ||
        data.ErrorDetails ||
        "OCR.Space 처리 오류";

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: false, error: errMsg }),
      };
    }

    const parsed =
      data.ParsedResults && data.ParsedResults[0] ? data.ParsedResults[0] : null;
    const text = parsed && parsed.ParsedText ? parsed.ParsedText : "";

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, text }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        error: String(e && e.message ? e.message : e),
      }),
    };
  }
};

