// netlify/functions/solve.js
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { question } = JSON.parse(event.body || '{}') || {};
    if (!question || question.trim().length < 5) {
      return json({ answer: '잘 모르겠습니다' });
    }

    const system = `너는 편입 영어 문제 채점기다.
1) 오직 정답만 출력(숫자나 단어)
2) 해설/부연 금지
3) 애매하면 "잘 모르겠습니다"라고만 대답`;

    const payload = {
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: question + "\n정답은 간단히 번호/단어로만." }
      ],
      max_tokens: 8,
      temperature: 0
    };

    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) return json({ answer: `OpenRouter 오류: ${r.status}` });

    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content?.trim() || "잘 모르겠습니다";
    const answer = (text.length <= 16) ? text : "잘 모르겠습니다";
    return json({ answer });
  } catch (e) {
    return json({ answer: "에러: " + (e?.message || e) });
  }
};

function json(obj) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
