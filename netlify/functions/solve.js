// netlify/functions/solve.js
// OpenRouter로 5지선다 정답만 JSON으로 받는다.

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST,OPTIONS",
    },
    body: JSON.stringify(obj),
  };
}

function extractFirstJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  const candidate = s.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch { return null; }
}

async function openrouterChat({ apiKey, model, messages, maxTokens = 900 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        messages,
      }),
      signal: controller.signal,
    });

    const status = resp.status;
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      return { ok: false, status, error: data || { message: "OpenRouter HTTP error" } };
    }
    const content = data?.choices?.[0]?.message?.content || "";
    return { ok: true, status, content };
  } catch (e) {
    return { ok: false, status: 0, error: String(e && (e.message || e)) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method Not Allowed" });

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;

  if (!apiKey) return json(500, { ok: false, error: "Missing OPENROUTER_API_KEY env" });
  if (!model) return json(500, { ok: false, error: "Missing OPENROUTER_MODEL env" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok:false, error:"Bad JSON body" }); }

  const items = Array.isArray(body.items) ? body.items : null;
  if (!items || items.length === 0) return json(400, { ok:false, error:"Missing items" });

  const payload = items.map(it => ({
    n: it.n,
    context: String(it.context || "").slice(0, 2200),
    stem: String(it.stem || "").slice(0, 600),
    choices: Array.isArray(it.choices) ? it.choices.map(x => String(x).slice(0, 220)) : [],
    underlined: String(it.underlined || "").slice(0, 220),
  }));

  const system = [
    "You are a top-tier Korean transfer-exam English multiple-choice solver.",
    "You must return ONLY valid JSON with no extra text.",
    "JSON format: {\"1\":3,\"2\":5,...} mapping question number to answer choice 1-5.",
    "If unsure, still pick the best answer. Never return 0 or null."
  ].join(" ");

  const user = [
    "Solve the following questions. Each is 5-choice.",
    "Use context if provided. If underlined phrase is provided, treat it as the underlined part of the question.",
    "Return JSON only.",
    JSON.stringify(payload)
  ].join("\n");

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  // 재시도(타임아웃/가끔 JSON 깨짐)
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await openrouterChat({ apiKey, model, messages, maxTokens: 900 });
    if (!r.ok) {
      if (attempt === 5) return json(502, { ok:false, error:"OpenRouter solve failed", detail: r });
      continue;
    }

    const obj = extractFirstJsonObject(r.content);
    if (!obj) {
      if (attempt === 5) return json(502, { ok:false, error:"Model did not return JSON", head: String(r.content).slice(0, 220) });
      continue;
    }

    // 검증
    const answers = {};
    for (const it of payload) {
      const key = String(it.n);
      const v = Number(obj[key]);
      if (![1,2,3,4,5].includes(v)) {
        if (attempt === 5) return json(502, { ok:false, error:`Invalid answer for ${key}`, got: obj });
        continue;
      }
      answers[key] = v;
    }

    return json(200, { ok:true, answers });
  }

  return json(502, { ok:false, error:"Unexpected solve exit" });
}
