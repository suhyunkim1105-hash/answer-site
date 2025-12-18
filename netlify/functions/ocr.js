// netlify/functions/ocr.js

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ ok: false, error: "Method not allowed" }),
    };
  }

  try {
    const { imageDataUrl, language } = JSON.parse(event.body || "{}");

    if (!imageDataUrl || typeof imageDataUrl !== "string") {
      return {
        statusCode: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ ok: false, error: "imageDataUrl is required" }),
      };
    }

    const apiKey = process.env.OCRSPACE_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ ok: false, error: "OCR API key not configured" }),
      };
    }

    // data URL에서 실제 base64 부분만 추출
    const base64 = imageDataUrl.split(",")[1] || imageDataUrl;

    const formBody = new URLSearchParams();
    formBody.append("apikey", apiKey);
    formBody.append("base64Image", "data:image/jpeg;base64," + base64);
    formBody.append("language", language || "kor");
    formBody.append("OCREngine", "2"); // 한글에 강한 엔진
    formBody.append("isTable", "false");
    formBody.append("scale", "true");

    const res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody.toString(),
    });

    const data = await res.json();

    if (data.IsErroredOnProcessing) {
      return {
        statusCode: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          ok: false,
          error: data.ErrorMessage || "OCR processing error",
        }),
      };
    }

    const parsedResults = data.ParsedResults || [];
    const text = parsedResults.map((r) => r.ParsedText || "").join("\n");

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: true, text }),
    };
  } catch (err) {
    console.error("OCR error", err);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        ok: false,
        error: "Unexpected error in OCR function",
      }),
    };
  }
};

