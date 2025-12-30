// netlify/functions/solve.js
// OpenRouter로 정답 산출. body.text 누락 시 "text required"를 확실히 막음.

exports.handler = async (event) => {
  try {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders, body: "" };
    }
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: "POST only" }) };
    }

    const body = JSON.parse(event.body || "{}");
    const text = (body.text || "").trim();
    if (!text) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "text required" }) };
    }

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
    const OPENROUTER_URL = process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions";

    if (!OPENROUTER_API_KEY) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "OPENROUTER_API_KEY missing" }) };
    }

    const system = [
      "You are a multiple-choice exam solver.",
      "You MUST return ONLY valid JSON.",
      'Format: {"answers":{"1":"A","2":"B",...}}',
      "Use ONLY uppercase letters A, B, C, D, E.",
      "Answer ONLY for questions you can find in the provided text; omit others.",
      "No commentary, no markdown, no extra keys."
    ].join(" ");

    const user = [
      "Solve the questions from the OCR text below.",
      "OCR TEXT START",
      text,
      "OCR TEXT END"
    ].join("\n");

    const payload = {
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.0,
      max_tokens: 800,
    };

    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({ error: "LLM upstream error", status: resp.status, raw: data }),
      };
    }

    const content = data?.choices?.[0]?.message?.content || "";
    // JSON만 추출 시도
    let parsed = null;
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      // content 안에 JSON이 섞여 나오는 경우 대비: 첫 { ... } 블록만 추출
      const m = content.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch (_) {}
      }
    }

    if (!parsed || !parsed.answers || typeof parsed.answers !== "object") {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Failed to parse JSON answers from model",
          raw: content,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ answers: parsed.answers }),
    };
  } catch (e) {
    return { statusCode: 500, headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: String(e) }) };
  }
};

