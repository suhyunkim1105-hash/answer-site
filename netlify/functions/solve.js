// netlify/functions/solve.js
// Netlify Functions (CJS)
// 필요 환경변수: OPENROUTER_API_KEY
// 선택: OPENROUTER_MODEL

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "POST only" }) };
    }

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    const text = (body.text || "").trim();

    if (!text || text.length < 50) {
      return { statusCode: 400, body: JSON.stringify({ error: "text too short" }) };
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: "OPENROUTER_API_KEY not set" }) };
    }

    const model = process.env.OPENROUTER_MODEL || "openai/gpt-5.2-thinking";

    const prompt = `
You are solving an English multiple-choice exam (1~50).
Return ONLY valid JSON in this exact schema:
{"answers":{"1":"A|B|C|D|E|?","2":"A|B|C|D|E|?",...,"50":"A|B|C|D|E|?"}}

Rules:
- Choose A-E.
- If missing/unclear, output "?".
- No explanations. No markdown. JSON only.
- Use ONLY the OCR text.

OCR TEXT:
${text}
`.trim();

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://netlify.app",
        "X-Title": "ocr-solve"
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0
      })
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "OpenRouter error", raw: data }) };
    }

    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
      ? String(data.choices[0].message.content).trim()
      : "";

    // JSON만 추출(모델이 실수로 앞뒤 텍스트 붙일 때 방어)
    let jsonText = content;
    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonText = content.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch {
      return { statusCode: 502, body: JSON.stringify({ error: "Model did not return valid JSON", raw: content }) };
    }

    const answers = parsed.answers || {};
    return { statusCode: 200, body: JSON.stringify({ answers }) };

  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || "SOLVE unknown error" }) };
  }
};
