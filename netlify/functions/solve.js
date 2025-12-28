// netlify/functions/solve.js
// 입력: { items: [{n, stem, choices[5]}] }
// 출력: { ok: true, answers: { "1": 3, ... } }
// 실패 시 자동 재시도는 프론트에서 무한 재시도 구조(“완전 자동”)로 처리한다.

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return json(500, { ok: false, error: "Missing OPENROUTER_API_KEY" });

    const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

    const body = safeJson(event.body);
    const items = body?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return json(400, { ok: false, error: "Invalid items" });
    }

    // 입력 검증(방어)
    const cleaned = items.map(x => ({
      n: Number(x?.n),
      stem: String(x?.stem || "").trim(),
      choices: Array.isArray(x?.choices) ? x.choices.map(c => String(c || "").trim()) : []
    })).filter(x => Number.isFinite(x.n) && x.n >= 1 && x.n <= 200 && x.stem && x.choices.length === 5);

    if (cleaned.length === 0) {
      return json(400, { ok: false, error: "No valid question items after cleaning" });
    }

    const prompt = buildPrompt(cleaned);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${key}`,
        // 권장 헤더(없어도 동작은 보통 함)
        "http-referer": "https://example.com",
        "x-title": "Auto OCR Exam Solver"
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 400,
        messages: [
          {
            role: "system",
            content:
              "You are a careful exam solver. Solve each English multiple-choice question. " +
              "Return ONLY valid JSON with the exact shape: {\"answers\":{\"1\":3,\"2\":5}}. " +
              "Keys must be strings of the question number, values must be integers 1-5. " +
              "No explanations, no markdown, no extra text."
          },
          { role: "user", content: prompt }
        ]
      }),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return json(502, { ok: false, error: `OpenRouter HTTP ${resp.status}: ${t.slice(0,200)}` });
    }

    const data = await resp.json().catch(() => null);
    if (!data) return json(502, { ok: false, error: "OpenRouter returned invalid JSON" });

    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      return json(502, { ok: false, error: "Empty model content" });
    }

    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== "object" || !parsed.answers || typeof parsed.answers !== "object") {
      return json(200, { ok: false, error: "Model output is not valid JSON answers object" });
    }

    // 정규화: ① 같은 출력이 오면 1~5로 바꿈
    const answers = {};
    for (const q of cleaned) {
      const raw = parsed.answers[String(q.n)];
      const v = normalizeAnswerValue(raw);
      if (!v) {
        return json(200, { ok: false, error: `Missing/invalid answer for ${q.n}` });
      }
      answers[String(q.n)] = v;
    }

    return json(200, { ok: true, answers });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
}

function buildPrompt(items) {
  // 가능한 한 짧고 명확하게
  let out = "";
  out += "Solve the following questions. Return JSON only.\n\n";
  for (const it of items) {
    out += `Q${it.n}: ${it.stem}\n`;
    out += `1) ${it.choices[0]}\n`;
    out += `2) ${it.choices[1]}\n`;
    out += `3) ${it.choices[2]}\n`;
    out += `4) ${it.choices[3]}\n`;
    out += `5) ${it.choices[4]}\n\n`;
  }
  out += "Remember: output ONLY JSON: {\"answers\":{\"1\":3,...}}";
  return out;
}

function normalizeAnswerValue(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^[1-5]$/.test(s)) return Number(s);

  const map = { "①":1,"②":2,"③":3,"④":4,"⑤":5 };
  if (map[s]) return map[s];

  const m = s.match(/([1-5])/);
  if (m) return Number(m[1]);
  return null;
}

function extractJson(text) {
  // 모델이 실수로 앞뒤 글자를 붙이면 JSON 블록만 뽑는다.
  const t = String(text).trim();

  // 1) 전체가 JSON이면 바로
  const direct = safeJson(t);
  if (direct) return direct;

  // 2) 첫 { 부터 마지막 } 까지 잘라서
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
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(obj)
  };
}
