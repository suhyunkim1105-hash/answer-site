// netlify/functions/ocr.js
// Node 18+ (Netlify Functions) 기준

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const apiKey = (process.env.OCR_SPACE_API_KEY || "").trim();

    // 🔒 디버그(키 유출 방지): 길이만 로그
    console.log("[ocr] OCR_SPACE_API_KEY length =", apiKey.length);

    if (!apiKey) {
      return json(500, {
        ok: false,
        error: "Server missing OCR_SPACE_API_KEY",
      });
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    // 프론트에서 imageBase64 또는 base64Image로 보내도 받게 함
    const imageBase64Raw = (body.imageBase64 || body.base64Image || "").trim();
    if (!imageBase64Raw) {
      return json(400, { ok: false, error: "Missing imageBase64/base64Image" });
    }

    // dataURL 형태든 순수 base64든 처리
    const base64Image = imageBase64Raw.startsWith("data:")
      ? imageBase64Raw
      : `data:image/jpeg;base64,${imageBase64Raw}`;

    // OCR.Space 파라미터 (영어 시험이면 eng)
    const language = (body.language || "eng").toString();

    const params = new URLSearchParams();
    params.set("apikey", apiKey);
    params.set("base64Image", base64Image);
    params.set("language", language);
    params.set("isOverlayRequired", "false");
    params.set("detectOrientation", "true");
    params.set("scale", "true");
    params.set("OCREngine", "2");

    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: params.toString(),
    });

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // OCR.Space가 JSON 아닌 걸 뱉으면 그대로 보여줌
      return json(resp.status || 502, {
        ok: false,
        error: "OCR upstream non-JSON response",
        status: resp.status || 502,
        detail: text.slice(0, 500),
      });
    }

    // OCR.Space가 에러를 반환한 경우
    // 보통 isErroredOnProcessing + ErrorMessage or 403 invalid
    const isErrored = !!data?.IsErroredOnProcessing;
    const errMsg = Array.isArray(data?.ErrorMessage)
      ? data.ErrorMessage.filter(Boolean).join(" / ")
      : (data?.ErrorMessage || "").toString();

    if (!resp.ok || isErrored) {
      // OCR.Space의 403 invalid 같은 상태를 그대로 전달
      return json(resp.status || 502, {
        ok: false,
        error: "OCR HTTP error",
        status: resp.status || 502,
        detail: errMsg || data?.ErrorDetails || "Unknown OCR error",
        rawExitCode: data?.OCRExitCode,
      });
    }

    const parsedText =
      data?.ParsedResults?.[0]?.ParsedText?.toString() || "";

    // 간단한 “품질” 점수(정교한 conf는 OCR.Space 응답에 없는 경우가 많음)
    // 길이 기반: 너무 짧으면 품질 낮다고 판단하는 정도로만 사용
    const approxConf = clamp(
      Math.round((Math.min(parsedText.length, 2500) / 2500) * 100),
      0,
      100
    );

    return json(200, {
      ok: true,
      text: parsedText,
      conf: approxConf,
    });
  } catch (e) {
    console.error("[ocr] fatal", e);
    return json(500, {
      ok: false,
      error: "Server error",
      detail: String(e?.message || e),
    });
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
