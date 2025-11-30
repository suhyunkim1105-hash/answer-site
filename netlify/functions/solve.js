// /.netlify/functions/solve.js

export async function handler(event, context) {
  try {
    const payload  = JSON.parse(event.body || "{}");
    const mode     = (payload.mode || "reading").toLowerCase();
    const passage  = (payload.passage || "").trim();
    const question = (payload.question || "").trim();
    const stt      = (payload.stt || "").trim();

    // Netlify 환경변수 OPENROUTER_MODEL 없으면 gpt-5 기본 사용
    const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-5";

    const prompt = buildPrompt(mode, passage, question, stt);

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
          {
            role: "system",
            content: "Follow the exact output format requested. Prefer giving a concrete answer when there is at least weak evidence. Only use [ANSWER] ? when you truly cannot tell at all."
          },
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
  // ---------- READING ----------
  if (mode === "reading") {
    return `
You are a TOEFL iBT Reading answer engine.

<Reading Passage>
${passage}

<Question & Options (1~5, may be long)>
${question}

Rules:
- Choose the correct option among 1~5 when there is at least about 20% confidence (even weak evidence is OK).
- Try to eliminate clearly wrong choices and then pick the best remaining option.
- Only when you truly cannot eliminate any options and it would be pure random guessing, output "[ANSWER] ?".
- Do NOT output multiple answers.

Output Format (STRICT):
[ANSWER] N or ?
[WHY] 한국어로 핵심 근거 또는 불확실한 이유를 2~4줄로 설명
`;
  }

  // ---------- LISTENING ----------
  if (mode === "listening") {
    return `
You are a TOEFL iBT Listening answer engine.

<Listening transcript from audio STT (may contain minor errors)>
${stt}

<On-screen question text or context (optional)>
${passage}

<Options text (1~5, may include question again)>
${question}

Rules:
- Use the transcript and any on-screen text together.
- Consider that STT may contain small recognition errors.
- Choose an option 1~5 whenever you have at least about 20% confidence.
- Try to eliminate obviously wrong answers first and pick the best remaining.
- Only when you truly cannot tell and every option is equally plausible, output "[ANSWER] ?".
- Never output more than one number.

Output Format (STRICT):
[ANSWER] N or ?
[WHY] 한국어로 핵심 근거 또는 불확실한 이유를 2~4줄로 설명
`;
  }

  // ---------- WRITING ----------
  if (mode === "writing") {
    return `
You are a TOEFL iBT Writing essay generator.

<Reading passage or notes (optional, for integrated tasks)>
${passage}

<On-screen writing prompt text (optional)>
${question}

<Spoken prompt from audio STT (optional)>
${stt}

Some of the above may be empty; use whatever is available.

Task:
1) Write a TOEFL-style independent or integrated essay based on the given information.
2) Length: STRICTLY 250~320 words.
3) Clear structure: introduction, 2 body paragraphs, and conclusion.
4) Follow TOEFL Writing criteria: task achievement, organization, development, vocabulary, and grammar.
5) After the essay, provide Korean feedback (3~5 lines) commenting on structure, content, and grammar as if you were scoring it.

Output Format (STRICT):
[ESSAY]
(essay here)

[FEEDBACK]
(한국어 피드백 3~5줄)
`;
  }

  // ---------- SPEAKING ----------
  if (mode === "speaking") {
    return `
You are a TOEFL iBT Speaking evaluator.

<Question text from screen/OCR (may be empty)>
${question}

<Extra passage or notes (optional)>
${passage}

<My spoken answer (STT transcription; may contain minor errors)>
${stt}

Assume:
- This is a TOEFL iBT Speaking task.
- The student's speaking time limit is about 45 seconds.
- A natural model answer should be about 90~120 words (do NOT exceed 130 words).

Task:
1) Evaluate the student's answer in English, using TOEFL Speaking criteria:
   - Delivery (pronunciation, intonation, pacing)
   - Language use (grammar, vocabulary)
   - Topic development (organization, coherence, detail)
2) Mention specific strengths and weaknesses.
3) Give an approximate level (e.g., High, Mid, Low).
4) Provide a 45~60 second model answer in English (around 90~120 words).
5) Finally, give a short Korean summary and improvement tips (3~5 lines).

Output Format (STRICT):
[EVAL]
(English evaluation: delivery, language use, topic development, level)

[MODEL]
(45~60 second model answer in English, about 90~120 words)

[KOREAN]
(한국어 요약 및 개선 팁 3~5줄)
`;
  }

  // fallback
  return "Invalid mode. Use reading / listening / writing / speaking.";
}

// ---------------- SHORT TTS EXTRACTOR ----------------

function extractTTS(mode, text) {
  if (mode === "reading" || mode === "listening") {
    const m = text && text.match(/\[ANSWER\]\s*([1-5])/i);
    if (m) {
      return `The correct answer is number ${m[1]}.`;
    }
  }
  if (mode === "speaking") {
    return "Here is your speaking evaluation summary.";
  }
  return null;
}
