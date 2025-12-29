// netlify/functions/solve.js
// OpenRouter proxy solver (CommonJS)
// Required env var: OPENROUTER_API_KEY
// Optional env var: SOLVE_MODEL (default: openai/gpt-4o-mini)

function json(statusCode, obj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      ...extraHeaders,
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return json(204, {}, { "Content-Length": "0" });
    }

    if (event.httpMethod !== "POST") {
      return json(405, { error: "POST only" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, { error: "OPENROUTER_API_KEY not set (Netlify 환경변수에 추가 필요)" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      return json(400, { error: "text required" });
    }

    const model = process.env.SOLVE_MODEL || "openai/gpt-4o-mini";

    const system =
      "You are an exam answer extractor. Return ONLY valid JSON. " +
      "Given OCR text of an English multiple-choice test, infer answers 1-50. " +
      "Output format: {\"answers\": {\"1\": \"A\", ... , \"50\": \"E\"}}. " +
      "Use only A/B/C/D/E. If uncertain, still pick the most likely.";

    const user = "OCR TEXT:\n" + text + "\n\nReturn ONLY JSON.";

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return json(502, { error: "OpenRouter error", status: resp.status, raw: data });
    }

    const content = data?.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return json(502, { error: "Model did not return valid JSON", raw: content });
    }

    return json(200, parsed);
  } catch (e) {
    return json(500, { error: e?.message || "Solve unknown error" });
  }
};
