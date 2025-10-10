exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Use POST" }) };
  }
  try {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing OPENROUTER_API_KEY" }) };
    }
    const body = JSON.parse(event.body || "{}");
    const question = body.question;
    if (!question || typeof question !== "string") {
      return { statusCode: 400, body: JSON.stringify({ error: "question (string) required" }) };
    }
    const system = `너는 시험 감독관 보조 AI다. 사용자가 준 문제 텍스트를 보고, 계산 또는 간단한 근거만으로 "최종 정답 한 줄"만 출력한다. 장황한 설명 금지.`;
    const user = `문제:\n${question}\n요청: 정답만 한 줄로.`;
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.0,
        max_tokens: 64
      })
    });
    const j = await r.json();
    if (!r.ok) {
      return { statusCode: r.status, body: JSON.stringify({ error: j?.error?.message || j }) };
    }
    const answer = j?.choices?.[0]?.message?.content?.trim() || "";
    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ answer })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || String(e) }) };
  }
};
