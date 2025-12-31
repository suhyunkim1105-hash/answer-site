// netlify/functions/solve.js (그대로 덮어쓰기)
// OpenRouter로 "정답만 JSON" 강제 + 파싱/검증/재시도
export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "POST only" }) };
    }

    const { OPENROUTER_API_KEY, OPENROUTER_MODEL } = process.env;
    if (!OPENROUTER_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing OPENROUTER_API_KEY" }) };
    }

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { body = {}; }

    const text = body.text;
    if (!text || typeof text !== "string" || text.trim().length < 300) {
      return { statusCode: 400, body: JSON.stringify({ error: "text required" }) };
    }

    const model = OPENROUTER_MODEL || "openai/gpt-5.2-thinking";

    const system = `
You are an exam answer extractor.
Return ONLY valid JSON and nothing else.
JSON schema:
{"answers":{"1":"A","2":"B",...}}

Rules:
- Answers must be one of A,B,C,D,E only.
- Use the question numbers as they appear.
- If a question is missing or unreadable, omit it (do NOT guess).
- Do not include explanations.
`;

    // 노이즈를 조금 줄여줌(광고/잡문자 줄이기)
    const cleaned = text
      .replace(/[^\S\r\n]+/g, " ")
      .replace(/\n{3,}/g, "\n\n");

    const user = `
Extract answers from this exam OCR text.
Return ONLY JSON.

OCR TEXT:
${cleaned}
`;

    async function callOpenRouter(messages) {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages,
        }),
      });

      const j = await r.json().catch(() => null);
      if (!r.ok || !j) throw new Error(j?.error?.message || "OpenRouter request failed");
      const content = j.choices?.[0]?.message?.content ?? "";
      return { content, raw: j };
    }

    function extractJson(text) {
      const s = (text || "").trim();
      // 1) 바로 JSON
      try { return JSON.parse(s); } catch {}

      // 2) 본문 중 {...} 블록만 떼기
      const first = s.indexOf("{");
      const last = s.lastIndexOf("}");
      if (first !== -1 && last !== -1 && last > first) {
        const sub = s.slice(first, last + 1);
        try { return JSON.parse(sub); } catch {}
      }
      return null;
    }

    function normalizeAnswers(obj) {
      if (!obj || typeof obj !== "object") return null;
      const answers = obj.answers;
      if (!answers || typeof answers !== "object") return null;

      const out = {};
      for (const [k, v] of Object.entries(answers)) {
        const kk = String(k).trim();
        const vv = String(v).trim().toUpperCase();
        if (!/^\d+$/.test(kk)) continue;
        if (!["A","B","C","D","E"].includes(vv)) continue;
        out[kk] = vv;
      }
      if (Object.keys(out).length === 0) return null;
      return out;
    }

    // 1차 호출
    const first = await callOpenRouter([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);

    let parsed = extractJson(first.content);
    let answers = normalizeAnswers(parsed);

    // 실패하면 2차: “JSON만 다시 출력”
    if (!answers) {
      const second = await callOpenRouter([
        { role: "system", content: system },
        { role: "user", content: user },
        { role: "assistant", content: first.content },
        { role: "user", content: "Your previous output was not valid JSON. Return ONLY valid JSON in the required schema." },
      ]);
      parsed = extractJson(second.content);
      answers = normalizeAnswers(parsed);

      if (!answers) {
        return { statusCode: 502, body: JSON.stringify({ error: "Model output not parseable as answers JSON", raw: second.content }) };
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          answers,
          answer_text: Object.keys(answers).sort((a,b)=>Number(a)-Number(b)).map(k=>`${k}번: ${answers[k]}`).join("\n"),
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        answers,
        answer_text: Object.keys(answers).sort((a,b)=>Number(a)-Number(b)).map(k=>`${k}번: ${answers[k]}`).join("\n"),
      }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || "unknown" }) };
  }
};

