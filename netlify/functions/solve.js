// netlify/functions/solve.js
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, { ok: false, error: "OPENROUTER_API_KEY is not set" });
    }

    const model = process.env.MODEL_NAME || "openai/gpt-4.1";
    const stopToken = process.env.STOP_TOKEN || "XURTH";
    const temperature = Number(process.env.TEMPERATURE ?? 0.1);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const ocrText = String(body.ocrText || body.text || "");
    if (!ocrText.trim()) {
      return json(400, { ok: false, error: "Missing ocrText" });
    }

    const prompt = buildPrompt(ocrText, stopToken);

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature,
        stop: [stopToken],
        messages: [
          {
            role: "system",
            content: "You output ONLY answers in the required format. No extra text.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });

    const raw = await res.text();
    if (!res.ok) {
      return json(res.status, {
        ok: false,
        error: "OpenRouter error",
        raw: raw.slice(0, 1500),
      });
    }

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      // 모델 응답이 JSON 파싱 안 되면 text만 빈 문자열로 처리
    }

    const text = data?.choices?.[0]?.message?.content
      ? String(data.choices[0].message.content)
      : "";

    return json(200, {
      ok: true,
      text,
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "Internal server error in solve",
      detail: String(e?.message || e),
    });
  }
};

function buildPrompt(ocrText, stopToken) {
  return `
You are solving a multiple-choice test from OCR text.

RULES:
- Output ONLY in this format:
1: A
2: B
...
UNSURE: (list numbers or '-')
${stopToken}

- No explanations.
- If OCR is unclear for a number, put that number into UNSURE.

OCR TEXT:
${ocrText}
`.trim();
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

