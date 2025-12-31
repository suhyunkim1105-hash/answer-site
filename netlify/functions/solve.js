export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "method not allowed" });
    }

    const { text } = safeJson(event.body);

    // ✅ 여기서 "text required" 방어
    if (!text || typeof text !== "string" || text.trim().length < 50) {
      return json(400, { error: "text required (min length 50)" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
    if (!apiKey) return json(500, { error: "OPENROUTER_API_KEY missing" });

    const prompt = [
      "You are a strict answer extractor.",
      "Given an English multiple-choice exam OCR text, output ONLY valid JSON in the exact format:",
      '{"answers":{"1":"A","2":"B"}}',
      "",
      "Rules:",
      "- Keys must be question numbers as strings.",
      "- Values must be one of A,B,C,D,E.",
      "- Do not include any other text.",
      "",
      "OCR TEXT:",
      text
    ].join("\n");

    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "user", content: prompt }
        ]
      })
    });

    const j = await r.json().catch(() => null);
    if (!r.ok) {
      return json(r.status, { error: `openrouter failed (${r.status})`, raw: j });
    }

    const content = j?.choices?.[0]?.message?.content ?? "";
    const extracted = extractJsonObject(content);

    if (!extracted) {
      return json(502, { error: "model did not return valid JSON", raw: content });
    }

    // answers 정규화
    const answers = extracted.answers || {};
    const norm = {};
    for (const [k,v] of Object.entries(answers)) {
      const kk = String(parseInt(k, 10));
      const vv = String(v || "").trim().toUpperCase();
      if (!kk || !["A","B","C","D","E"].includes(vv)) continue;
      norm[kk] = vv;
    }

    return json(200, { answers: norm });

  } catch (e) {
    return json(500, { error: e.message || String(e) });
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  };
}

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}

function extractJsonObject(text) {
  // 모델이 앞뒤로 말을 섞어도 첫 JSON 오브젝트만 뽑아내기
  const s = String(text || "").trim();

  // 1) 그대로 JSON인 경우
  try { return JSON.parse(s); } catch {}

  // 2) 텍스트 중 {...} 구간 추출
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const chunk = s.slice(first, last + 1);
    try { return JSON.parse(chunk); } catch {}
  }

  return null;
}
