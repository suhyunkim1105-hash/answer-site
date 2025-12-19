// netlify/functions/ocr.js
export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  try {
    const OCRSPACE_API_KEY = process.env.OCRSPACE_API_KEY;
    if (!OCRSPACE_API_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "서버 설정 오류: OCRSPACE_API_KEY 환경변수가 없습니다." }) };
    }

    const body = JSON.parse(event.body || "{}");
    const imageDataUrl = body.imageDataUrl || "";
    const language = body.language || "kor";
    const ocrEngine = body.ocrEngine || 2;
    const detectOrientation = body.detectOrientation !== false;
    const scale = body.scale !== false;

    if (!imageDataUrl.startsWith("data:image/")) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "imageDataUrl이 올바른 data:image/... 형식이 아닙니다." }) };
    }

    // OCR.Space: base64Image는 "data:image/jpeg;base64,..." 형태 그대로 넣어도 됨
    const params = new URLSearchParams();
    params.set("apikey", OCRSPACE_API_KEY);
    params.set("base64Image", imageDataUrl);
    params.set("language", language);
    params.set("OCREngine", String(ocrEngine));
    params.set("isOverlayRequired", "false");
    params.set("detectOrientation", detectOrientation ? "true" : "false");
    params.set("scale", scale ? "true" : "false");

    // 표/도표 섞인 문서에서 도움이 되는 경우가 있음(항상 이득은 아님)
    // params.set("isTable", "true");

    const res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: params.toString()
    });

    const json = await res.json().catch(() => null);

    if (!res.ok || !json) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `OCR.Space 응답 오류(HTTP ${res.status})`, raw: json }) };
    }

    // OCR.Space 에러 형식
    if (json.IsErroredOnProcessing) {
      const msg = (json.ErrorMessage && json.ErrorMessage[0]) || json.ErrorMessage || json.ErrorDetails || "OCR 처리 에러";
      return { statusCode: 200, headers, body: JSON.stringify({ text: "", reason: String(msg), meta: json }) };
    }

    const parsedText = (json.ParsedResults?.[0]?.ParsedText || "").trim();

    // 빈 결과 디버그를 위해 meta도 같이 반환
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        text: parsedText,
        meta: {
          OCRExitCode: json.OCRExitCode,
          ParsedTextLength: parsedText.length,
          SearchablePDFURL: json.SearchablePDFURL || null,
          ProcessingTimeInMilliseconds: json.ProcessingTimeInMilliseconds || null
        }
      })
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err?.message || String(err) }) };
  }
}

