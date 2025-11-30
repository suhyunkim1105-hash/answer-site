// /.netlify/functions/solve.js
import fetch from "node-fetch";

export async function handler(event, context) {
  try {
    const { mode, passage, question, stt } = JSON.parse(event.body);

    const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

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

// ---------------------- Prompt Builder ----------------------
function buildPrompt(mode, passage, question, stt) {

  if (mode === "reading") {
    return `
TOEFL Reading 문제다.
지문:
${passage}

문제/선지:
${question}

1) 정답: N (1~5 중 숫자만)
2) 한국어 해설: 핵심 근거 + 오답 이유 간단히
`;
  }

  if (mode === "writing") {
    const finalQuestion = stt?.trim() ? stt : question;
    return `
다음은 TOEFL Writing 문제다:
${finalQuestion}

요구사항:
1) 250~320 단어 영어 에세이 작성
2) 마지막에 한국어로 구조/내용/문법 피드백 3~5줄
`;
  }

  if (mode === "listening") {
    const script = stt || "";
    return `
TOEFL Listening 문제다.

리스닝 스크립트(STT):
${script}

보기/문제:
${question}

요구사항:
1) 정답: N (1~5)
2) 한국어 해설(핵심 근거 3줄)
`;
  }

  if (mode === "speaking") {
    const answer = stt || "";
    const q = question || "";
    return `
TOEFL Speaking 평가.

문제:
${q}

내 답변(STT):
${answer}

요구사항:
1) 답변 평가(내용/조직/언어/유창성)
2) 강점/약점
3) 간단한 점수 느낌(예: High-Mid)
4) 모범답안(45~60초 분량)
5) 마지막에 한국어 총평
`;
  }

  return "Invalid mode.";
}

// ---------------------- Short TTS Extractor ----------------------
function extractTTS(mode, text) {
  if (mode === "reading" || mode === "listening") {
    const m = text.match(/정답[:：]\s*([1-5])/);
    if (m) return `The correct answer is number ${m[1]}.`;
  }
  if (mode === "speaking") {
    return "Here is your speaking evaluation summary.";
  }
  return null;
}

