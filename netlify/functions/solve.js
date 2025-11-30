// /.netlify/functions/solve.js

export async function handler(event, context) {
  try {
    const { mode, passage, question, stt } = JSON.parse(event.body || "{}");

    const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-5";
    const prompt = buildPrompt(mode, passage || "", question || "", stt || "");

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
          { role: "system", content: "You MUST follow the output format exactly and keep it concise." },
          { role: "user", content: prompt }
        ]
      })
    }).then(r => r.json());

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

<Question & Options>
${question}

Task:
1) Choose the correct option among 1~5.
2) Provide short Korean reasoning.

Output Format (STRICT):
[ANSWER] N
[WHY] 한국어로 핵심 근거 2~3줄
`;
  }

  if (mode === "listening") {
    return `
You are a TOEFL Listening answer engine.

<STT Script from audio>
${stt}

<Question & Options>
${question}

Task:
1) Choose the correct option among 1~5.
2) Provide short Korean reasoning.

Output Format (STRICT):
[ANSWER] N
[WHY] 한국어로 2~3줄로 핵심 근거 설명
`;
  }

  if (mode === "writing") {
    const q = stt.trim() ? stt : question;
    return `
You are a TOEFL Writing essay generator.

<Question>
${q}

Task:
1) Write an independent TOEFL-style essay.
2) Length: 250~320 words STRICTLY.
3) Clear intro, 2 body paragraphs, and conclusion.
4) After the essay, give Korean feedback (3~5 lines) about structure, content, and grammar.

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

<My Answer (STT transcription)>
${stt}

Task:
1) Give evaluation in English (Delivery / Language / Topic development).
2) Mention strengths & weaknesses.
3) Give an approximate level (e.g., High, Mid, Low).
4) Provide a model answer (~45-60 seconds).
5) Provide a short Korean summary and improvement tips.

Output Format:
[EVAL]
(English evaluation)

[MODEL]
(45~60 second model answer)

[KOREAN]
(Korean summary and tips)
`;
  }

  // fallback (should not happen)
  return "Invalid mode. Use one of: reading, writing, listening, speaking.";
}

// ---------------- SHORT TTS EXTRACTOR ----------------

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
