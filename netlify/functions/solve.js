// netlify/functions/solve.js
// 입력: { items: [{n, context, stem, choices[5], underlined(optional)}] }
// 출력: { ok:true, answers: { "1":3, "2":5, ... } }

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { ok:false, error:"Method Not Allowed" });

    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return json(500, { ok:false, error:"Missing OPENROUTER_API_KEY" });

    const model = process.env.OPENROUTER_MODEL;
    if (!model) return json(500, { ok:false, error:"Missing OPENROUTER_MODEL" });

    const body = safeJson(event.body);
    const items = Array.isArray(body && body.items) ? body.items : [];
    if (items.length === 0) return json(400, { ok:false, error:"Invalid items" });

    const cleaned = items.map(x => ({
      n: Number(x?.n),
      context: String(x?.context || "").trim(),
      stem: String(x?.stem || "").trim(),
      choices: Array.isArray(x?.choices) ? x.choices.map(c => String(c || "").trim()) : [],
      underlined: String(x?.underlined || "").trim()
    })).filter(x =>
      Number.isFinite(x.n) && x.n >= 1 && x.n <= 60 &&
      x.stem && x.choices.length === 5
    );

    if (cleaned.length === 0) return json(400, { ok:false, error:"No valid items after cleaning" });

    const system = [
      "Return ONLY valid JSON. Absolutely no extra text.",
      "Format exactly: {\"answers\":{\"1\":3,\"2\":5}}",
      "Keys must be question numbers as strings.",
      "Values must be integers 1-5.",
      "Do NOT include explanations."
    ].join(" ");

    const prompt = buildPrompt(cleaned);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type":"application/json",
        "authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 280,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ]
      }),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    if (!resp.ok) {
      const t = await resp.text().catch(()=> "");
      return json(502, { ok:false, error:`OpenRouter HTTP ${resp.status}: ${t.slice(0,200)}` });
    }

    const data = await resp.json().catch(() => null);
    if (!data) return json(502, { ok:false, error:"OpenRouter returned invalid JSON" });

    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") return json(502, { ok:false, error:"Empty model content" });

    const obj = extractJson(content);
    if (!obj || typeof obj !== "object" || !obj.answers || typeof obj.answers !== "object") {
      return json(200, { ok:false, error:"Model output is not valid JSON {answers:{...}}" });
    }

    const answers = {};
    for (const q of cleaned) {
      const v = normalizeAnswer(obj.answers[String(q.n)]);
      if (!v) return json(200, { ok:false, error:`Missing/invalid answer for ${q.n}` });
      answers[String(q.n)] = v;
    }

    return json(200, { ok:true, answers });
  } catch (e) {
    return json(500, { ok:false, error: String(e && (e.message || e)) });
  }
};

function buildPrompt(items) {
  let out = "";
  out += "Solve the following English multiple-choice questions.\n";
  out += "If 'Underlined expression' is provided, treat it as the underlined target.\n";
  out += "Return ONLY JSON: {\"answers\":{\"1\":3}}.\n\n";

  for (const it of items) {
    out += `Q${it.n}:\n`;
    if (it.context) out += `PASSAGE/CONTEXT:\n${it.context}\n\n`;
    if (it.underlined) out += `Underlined expression: ${it.underlined}\n`;
    out += `${it.stem}\n`;
    out += `1) ${it.choices[0]}\n`;
    out += `2) ${it.choices[1]}\n`;
    out += `3) ${it.choices[2]}\n`;
    out += `4) ${it.choices[3]}\n`;
    out += `5) ${it.choices[4]}\n\n`;
  }
  out += "Return ONLY JSON.";
  return out;
}

function normalizeAnswer(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^[1-5]$/.test(s)) return Number(s);
  const m = s.match(/([1-5])/);
  if (m) return Number(m[1]);
  return null;
}

function extractJson(text) {
  const t = String(text).trim();
  const direct = safeJson(t);
  if (direct) return direct;

  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const slice = t.slice(first, last + 1);
    const obj = safeJson(slice);
    if (obj) return obj;
  }
  return null;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store"
    },
    body: JSON.stringify(obj)
  };
}

