// /.netlify/functions/solve.js

export async function handler(event, context) {
  try {
    const { mode, passage, question, stt } = JSON.parse(event.body);

    const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-5";

    const prompt = buildPrompt(mode, passage, question, stt);

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.2,
          max_tokens: 800,
          messages: [
            { role: "system", content: "You MUST follow the output format exactly." },
            { role: "user", content: prompt }
          ]
        })
      }
    ).then(r => r.json());

    const out = response?.choices?.[0]?.message?.content || "AI 응답 오류";

    return {
      statusCode: 200,
      body: JSON.stringify({
        result: out,
        tts: extractTTS(mode, out)
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.toString() })
    };
  }
}


// ---------------- PROMPT BUILDER ----------------
function buildPrompt(mode, passage, question, stt) {

  if (mode === "reading") {
    return `
You are a TOEFL Reading answer engine.

<Passage>
${passage}

<Question>
${question}

Output Format (STRICT):
[ANSWER] N
[WHY] 한국어로 핵심 근거 2~3줄
`;
  }

  if (mode === "listening") {
    return `
You are a TOEFL Listening answer engine.

<STT Script>
${stt}

<Question & Options>
${question}

Output Format (STRICT):
[ANSWER] N
[WHY] 한국어로 2~3줄로 핵심 근거 설명
`;
  }

  if (mode === "writing") {
    const q = stt?.trim() ? stt : question;
    return `
You are a TOEFL Writing essay generator.

<Question>
${q}

Task:
1) Write a TOEFL-style essay.
2) 250~320 words STRICTLY.
3) Clear intro / body / conclusion.
4) Korean feedback 3~5 lines.

Output Format:
[ESSAY]
(essay here)

[FEEDBACK]
(Korean feedback)
`;
  }

  if (mode === "speaking") {
    return `
You are a TOEFL Speaking evaluator.

<Question>
${question}

<My Answer (STT)>
${stt}

Task:
1) English evaluation (Delivery / Language / Topic).
2) Strengths & weaknesses.
3) Estimated level.
4) Model answer
5) Korean summary.

Output Format:
[EVAL]
(evaluation)

[MODEL]
(model answer)

[KOREAN]
(Korean summary)
`;
  }

  return "Invalid mode.";
}


// ---------------- SHORT TTS ----------------
function extractTTS(mode, text) {
  if (mode === "reading" || mode === "listening") {
    const m = text.match(/\[ANSWER\]\s*([1-5])/i);
    if (m) return `The correct answer is number ${m[1]}.`;
  }
  if (mode === "speaking") {
    return "Here is your speaking evaluation summary.";
  }
  return null;
}
