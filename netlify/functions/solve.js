// netlify/functions/solve.js
// POST { ocrText: "..." }
// Returns { ok, answers: { "1":"A"|...|"?" }, rawModelText }

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}

function normalizeText(t) {
  return (t || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractJsonObject(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : null;
}

function coerceAnswers(obj) {
  const out = {};
  for (let i = 1; i <= 50; i++) out[String(i)] = "?";

  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const kk = String(k).replace(/[^\d]/g, "");
      if (!kk) continue;
      const n = Number(kk);
      if (!Number.isFinite(n) || n < 1 || n > 50) continue;

      const vv = String(v || "").trim().toUpperCase();
      if (["A", "B", "C", "D", "E", "?"].includes(vv)) out[String(n)] = vv;
    }
  }
  return out;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method Not Allowed" });

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4.1";

    if (!OPENROUTER_API_KEY) return json(500, { ok: false, error: "OPENROUTER_API_KEY missing" });

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const ocrText = normalizeText(body.ocrText || body.text || "");
    if (!ocrText) return json(400, { ok: false, error: "Missing ocrText" });

    const system = [
      "You are a strict multiple-choice exam solver.",
      "You will receive messy OCR text of an English exam page set.",
      "Return ONLY a JSON object mapping question numbers 1..50 to one of: A, B, C, D, E, or ?.",
      "Rules:",
      "1) If you cannot be confident, output ? for that number.",
      "2) Do not include any extra keys, commentary, markdown, or explanations.",
      "3) Output must be valid JSON.",
    ].join("\n");

    const user = [
      "OCR TEXT START",
      ocrText,
      "OCR TEXT END",
      "",
      "Now output ONLY JSON like:",
      '{"1":"A","2":"?","3":"C",...,"50":"D"}',
    ].join("\n");

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://netlify.app",
        "X-Title": "answer-site",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
      }),
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      return json(502, { ok: false, error: "OpenRouter error", status: resp.status, detail: data });
    }

    const rawModelText =
      data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
        ? String(data.choices[0].message.content)
        : "";

    let parsed = null;
    try {
      parsed = JSON.parse(rawModelText);
    } catch {
      const j = extractJsonObject(rawModelText);
      if (j) {
        try {
          parsed = JSON.parse(j);
        } catch {
          parsed = null;
        }
      }
    }

    const answers = coerceAnswers(parsed);

    return json(200, { ok: true, answers, rawModelText });
  } catch (e) {
    return json(500, { ok: false, error: "Server error", detail: String(e && e.message ? e.message : e) });
  }
};
