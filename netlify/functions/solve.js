// /.netlify/functions/solve.js
import fetch from "node-fetch";

export async function handler(event, context) {
  try {
    const { mode, passage, question, stt } = JSON.parse(event.body);

    // 👉 기본 모델을 GPT-5로 설정
    const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-5";

    const prompt = buildPrompt(mode, passage, question, stt);

    const completion = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
      })
    }).then(r => r.json());

    const text = completion?.choices?.[0]?.message?.content || "AI 응답 오류";

    return {
      statusCode: 200,
      body: JSON.stringify({
        result: text,
        tts: extractTTS(mode, text)
      })
    };

  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.toString() }) };
  }
}

