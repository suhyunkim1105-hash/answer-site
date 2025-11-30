// /.netlify/functions/solve.js

export async function handler(event, context) {
  try {
    const { mode, passage, question, stt } = JSON.parse(event.body || "{}");

    const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-5";
    const prompt = buildPrompt(
      mode || "reading",
      (passage || "").trim(),
      (question || "").trim(),
      (stt || "").trim()
    );

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          { role: "system", content: "Follow the requested output format exactly. Do NOT invent answers when the information is insufficient." },
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

<Reading Passage>
${passage}

<Question & Options (may be long; may include 1~5 choices)>
${question}

Rules:
- Choose the correct option only if you are at least 80% confident.
- If the answer CANNOT be determined safely from the text, do NOT guess.
- In that case output "[ANSWER] ?" and explain why it is unclear.

Output Format (STRICT):
[ANSWER] N or ?
[WHY] 한국어로 핵심 근거 및 불확실하면 그 이유 2~4줄
`;
  }

  if (mode === "listening") {
    return `
You are a TOEFL Listening answer engine.

<Listening transcript from audio STT (may contain errors)>
${stt}

<On-screen question text (optional)>
${passage}

<Options text (1~5, may include question again)>
${question}

Rules:
- Use all information, but consider STT may have minor errors.
- Only choose an option if you are at least 80% confident.
- If the answer cannot be safely determined, output "[ANSWER] ?".
- Never randomly guess.

Output Format (STRICT):
[ANSWER] N or ?
[WHY] 한국어로 핵심 근거 및 불확실한 경우 그 이유 2~4줄
`;
  }

  if (mode === "writing") {
    return `
You are a TOEFL Writing essay generator.

<Reading passage (optional; for integrated tasks)>
${passage}

<On-screen writing prompt text (optional)>
${question}

<Spoken writing prompt from audio STT (optional)>
${stt}

Use whatever information is provided (some sections may be empty).

Task:
1) Write a TOEFL-style independent or integrated essay.
2) Length: 250~320 words STRICTLY.
3) Clear introduction, 2 body paragraphs, and conclusion.
4) After the essay, give Korean feedback (3~5 lines) on structure, content, and grammar.

Output Format (STRICT):
[ESSAY]
(essay here)

[FEEDBACK]
(한국어 피드백)
`;
  }

  if (mode === "speaking") {
    return `
You are a TOEFL Speaking evaluator.

<Question text from screen/OCR (may be empty)>
${question}

<Extra context passage (optional)>
${passage}

<My spoken answer (STT transcription; may contain minor errors)>
${stt}

Task:
1) Evaluate my answer in English (Delivery / Language use / Topic development).
2) List strengths and weaknesses.
3) Give an approximate level (e.g., High, Mid, Low).
4) Provide a 45~60 second model answer in English.
5) Finally, give a short Korean summary and improvement tips (3~5 lines).

Output Format (STRICT):
[EVAL]
(English evaluation)

[MODEL]
(45~60 second model answer)

[KOREAN]
(한국어 요약 및 조언)
`;
  }

  // fallback
  return "Invalid mode. Use reading / listening / writing / speaking.";
}

// ---------------- SHORT TTS EXTRACTOR ----------------

function extractTTS(mode, text) {
  if (mode === "reading" || mode === "listening") {
    // only speak when we have a clear numeric answer 1~5
    const m = text && text.match(/\[ANSWER\]\s*([1-5])/i);
    if (m) return `The correct answer is number ${m[1]}.`;
  }
  if (mode === "speaking") {
    return "Here is your speaking evaluation summary.";
  }
  return null;
}
