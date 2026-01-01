// netlify/functions/solve.js
// OpenRouter 호출 -> 여러 문항(원문 OCR)에서 정답(1~5)만 JSON으로 반환
// 입력: { items: [{ number: 1, text: "..." }, ...] }
// 출력: { ok:true, answers:{ "1":3, ... } } or { ok:false, error, detail }

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok:false, error:"Method Not Allowed" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(200, { ok:false, error:"Missing OPENROUTER_API_KEY env var" });
    }

    const body = safeJson(event.body);
    const items = Array.isArray(body?.items) ? body.items : null;
    if (!items || items.length === 0) {
      return json(200, { ok:false, error:"Missing items" });
    }

    const qList = items
      .map(x => ({
        number: Number(x?.number),
        text: String(x?.text || "").trim()
      }))
      .filter(x => Number.isFinite(x.number) && x.number >= 1 && x.number <= 50 && x.text.length >= 15);

    if (qList.length === 0) {
      return json(200, { ok:false, error:"No valid items" });
    }

    const prompt = buildPrompt(qList);
    const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

    const payload = {
      model,
      temperature: 0,
      messages: [
        { role: "system", content: "You solve multiple-choice exam questions. Output must be valid JSON only." },
        { role: "user", content: prompt }
      ],
    };

    const controller = new AbortController();
    const timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS || 15000);
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    }).catch((e) => ({ ok:false, _fetchError: e }));

    clearTimeout(t);

    if (resp && resp.ok === false && resp._fetchError) {
      return json(200, { ok:false, error:"OpenRouter fetch failed", detail:String(resp._fetchError?.message || resp._fetchError) });
    }

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return json(200, { ok:false, error:"OpenRouter upstream error", detail:data });
    }

    const text = data?.choices?.[0]?.message?.content ?? "";
    const parsed = parseAnswers(text);

    if (!parsed) {
      return json(200, { ok:false, error:"Failed to parse answers", raw:String(text).slice(0, 2000) });
    }

    // 배치에서 요청한 문항만 남김(모델이 이상한 키를 넣는 경우 방지)
    const allowed = new Set(qList.map(q => String(q.number)));
    const out = {};
    for (const [k,v] of Object.entries(parsed)) {
      if (allowed.has(String(k))) out[String(k)] = v;
    }

    if (Object.keys(out).length === 0) {
      return json(200, { ok:false, error:"Parsed empty answers", raw:String(text).slice(0, 2000) });
    }

    return json(200, { ok:true, answers: out });
  } catch (e) {
    const msg = String(e?.name === "AbortError" ? "OpenRouter timeout" : (e?.message || e));
    return json(200, { ok:false, error: msg });
  }
}

function buildPrompt(qList) {
  let s = "";
  s += "다음은 편입영어 5지선다 객관식 문제의 OCR 원문이다.\n";
  s += "각 문항의 정답을 1~5 번호로만 고르라.\n";
  s += "반드시 아래 JSON 한 덩어리만 출력하라(다른 텍스트 금지).\n";
  s += '형식: {"answers":{"1":3,"2":5,...}}\n';
  s += "주의: OCR이 깨져도 최대한 문맥으로 추론해서 1~5 중 하나를 선택하라.\n\n";

  for (const q of qList) {
    s += `문항 ${q.number}\n`;
    s += `${q.text}\n\n`;
  }

  s += "JSON만 출력하라.\n";
  return s;
}

function parseAnswers(text) {
  const t = String(text || "").trim();

  const firstBrace = t.indexOf("{");
  const lastBrace = t.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const jsonStr = t.slice(firstBrace, lastBrace + 1);
    try {
      const obj = JSON.parse(jsonStr);
      const ans = obj?.answers;
      if (ans && typeof ans === "object") {
        const out = {};
        for (const [k,v] of Object.entries(ans)) {
          const q = parseInt(k, 10);
          const c = parseInt(v, 10);
          if (Number.isFinite(q) && Number.isFinite(c) && c >= 1 && c <= 5) out[String(q)] = c;
        }
        if (Object.keys(out).length > 0) return out;
      }
    } catch (_) {}
  }

  // fallback: "1:3" 같은 형태
  const out = {};
  const re = /\b(0?[1-9]|[1-4][0-9]|50)\s*[:=]\s*([1-5])\b/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    out[String(parseInt(m[1], 10))] = parseInt(m[2], 10);
  }
  if (Object.keys(out).length > 0) return out;

  return null;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(obj),
  };
}

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch (_) { return {}; }
}


