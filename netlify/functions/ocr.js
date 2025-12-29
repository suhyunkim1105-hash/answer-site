// netlify/functions/ocr.js

export async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers: cors(),
        body: "",
      };
    }

    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const apiKey = (process.env.OCR_SPACE_API_KEY || "").trim();
    console.log("[ocr] OCR_SPACE_API_KEY length =", apiKey.length);

    if (!apiKey) {
      return json(500, { ok: false, error: "Server missing OCR_SPACE_API_KEY" });
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const imageBase64Raw = (body.imageBase64 || body.base64Image || "").trim();
    console.log("[ocr] imageBase64 length =", imageBase64Raw.length);

    if (!imageBase64Raw) {
      return json(400, { ok: false, error: "Missing imageBase64/base64Image" });
    }

    const base64Image = imageBase64Raw.startsWith("data:")
      ? imageBase64Raw
      : `data:image/jpeg;base64,${imageBase64Raw}`;

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
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: params.toString(),
    });

    const rawText = await resp.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return json(resp.status || 502, {
        ok: false,
        error: "OCR upstream non-JSON response",
        status: resp.status || 502,
        detail: rawText.slice(0, 500),
      });
    }

    const isErrored = !!data?.IsErroredOnProcessing;
    const errMsg = Array.isArray(data?.ErrorMessage)
      ? data.ErrorMessage.filter(Boolean).join(" / ")
      : (data?.ErrorMessage || "").toString();

    if (!resp.ok || isErrored) {
      return json(resp.status || 502, {
        ok: false,
        error: "OCR HTTP error",
        status: resp.status || 502,
        detail: errMsg || data?.ErrorDetails || "Unknown OCR error",
        rawExitCode: data?.OCRExitCode,
      });
    }

    const parsedText = data?.ParsedResults?.[0]?.ParsedText?.toString() || "";
    const approxConf = clamp(
      Math.round((Math.min(parsedText.length, 2500) / 2500) * 100),
      0, 100
    );

    return json(200, { ok: true, text: parsedText, conf: approxConf });
  } catch (e) {
    console.error("[ocr] fatal", e);
    return json(500, { ok: false, error: "Server error", detail: String(e?.message || e) });
  }
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(statusCode, obj) {
  return { statusCode, headers: { ...cors(), "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(obj) };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
