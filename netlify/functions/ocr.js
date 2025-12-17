// netlify/functions/ocr.js
// 서버 OCR: OCR.Space 사용 (한국어 Engine 2)
// 필요 env: OCRSPACE_API_KEY

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const apiKey = process.env.OCRSPACE_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: "OCRSPACE_API_KEY is not set" }) };
    }

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch (e) {}

    const imageBase64 = (body.imageBase64 || "").trim();
    if (!imageBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: "imageBase64 is required" }) };
    }

    // OCR.Space는 form-data를 기대
    const params = new URLSearchParams();
    params.set("apikey", apiKey);
    params.set("language", "kor");        // 한국어
    params.set("ocrengine", "2");         // Engine 2 (Korean 지원 안내)
    params.set("isOverlayRequired", "true");
    params.set("detectOrientation", "true");
    params.set("scale", "true");
    params.set("base64Image", "data:image/jpeg;base64," + imageBase64);

    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const raw = await resp.text();

    let data;
    try { data = JSON.parse(raw); }
    catch (e) {
      return {
        statusCode: 502,
        headers: { "Content-Type":"application/json; charset=utf-8" },
        body: JSON.stringify({ error: "OCR response not JSON", raw: raw.slice(0, 500) })
      };
    }

    if (data.IsErroredOnProcessing) {
      return {
        statusCode: 502,
        headers: { "Content-Type":"application/json; charset=utf-8" },
        body: JSON.stringify({ error: (data.ErrorMessage && data.ErrorMessage.join(" / ")) || "OCR error", raw: data })
      };
    }

    const parsed = (data.ParsedResults && data.ParsedResults[0]) ? data.ParsedResults[0] : null;
    const text = parsed && parsed.ParsedText ? parsed.ParsedText : "";
    const overlay = parsed && parsed.TextOverlay ? parsed.TextOverlay : null;

    // 대충 confidence 계산(단어 confidence 평균)
    let conf = 0;
    let cnt = 0;
    try {
      if (overlay && overlay.Lines) {
        for (const line of overlay.Lines) {
          if (!line.Words) continue;
          for (const w of line.Words) {
            const c = Number(w.WordConfidence);
            if (!Number.isNaN(c)) { conf += c; cnt++; }
          }
        }
      }
    } catch(e) {}

    const avgConf = cnt > 0 ? (conf / cnt) : 0;

    return {
      statusCode: 200,
      headers: { "Content-Type":"application/json; charset=utf-8" },
      body: JSON.stringify({
        text,
        conf: avgConf, // 0~100(대충)
        note: "OCR OK"
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type":"application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Server error", message: err.message || String(err) })
    };
  }
};
