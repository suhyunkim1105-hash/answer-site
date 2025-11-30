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
            content: "Follow the exact output format requested. For reading/listening, you MUST adapt the answer format to the TOEFL item type (single choice, multiple choice, sentence insertion, summary, table). Prefer giving a concrete answer when there is even weak evidence (~20% confidence). Only use [ANSWER] ? when there is truly no basis at all."
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
You are a TOEFL iBT Reading answer engine for the modern (internet-based) test.

You will receive:

<Reading Passage>
${passage}

<Question & options text (this may include question stem, 4 answer options, and instructions such as "Select TWO answers", "Complete the summary", "Complete the table", sentence insertion boxes, etc.)>
${question}

Your job:
1) Infer what type of TOEFL Reading item this is:
   - Single-answer 4-option multiple choice (ordinary radio button, one correct answer)
   - Multiple-answer 4-option multiple choice (e.g., "Select 2 answers", "Choose TWO answers")
   - Sentence insertion (choose where a given sentence fits among several [■] boxes in the passage)
   - Summary (3 blanks + 6 options, drag sentences into summary)
   - Table / classification (drag each statement into columns/rows/categories)

2) Give the answer in a format that matches the item type, using ONLY one [ANSWER] block and one [WHY] block as described below.

General confidence rule:
- If you can eliminate at least one option or see ANY weak preference, you must choose the best option(s) (≈ 20%+ confidence).
- Only output "[ANSWER] ?" when there is absolutely no evidence favoring any option over the others.

FORMATS BY ITEM TYPE
=====================

(1) Single-answer 4-option multiple choice
- Assume options are in order from top to bottom and can be mapped to numbers 1,2,3,4.
- Output:

[ANSWER] N
[WHY]
(한국어로 2~5줄: 왜 그 번호가 정답인지 설명 + 다른 보기들이 왜 덜 적합한지 간단히 언급)

Where N is 1–4.

(2) Multiple-answer 4-option multiple choice (e.g., "Select TWO answers")
- Again assume options are in order 1–4.
- Choose the required number of answers (usually 2).
- Output:

[ANSWER] 2,4
[WHY]
(한국어로 2~5줄: 왜 이 번호들이 둘 다 정답인지, 어떤 점에서 다른 보기와 구별되는지 설명)

(3) Sentence insertion
- The question usually says something like "Where would the following sentence best fit in the passage?"
- There are several possible positions in the passage (e.g., boxes or markers).
- Assume the candidate positions are numbered from top to bottom as 1,2,3,... in reading order.
- Output:

[ANSWER] INSERT-3
[WHY]
INSERT: 3
(한국어로 2~5줄: 왜 3번 위치에 넣는 것이 자연스러운지, 앞뒤 문맥과 논리 흐름을 근거로 설명)

(4) Summary (Complete the summary: 3 blanks, 6 options)
- Assume the options for the summary are listed from top to bottom and can be numbered 1..6.
- Choose exactly three numbers which best represent the main ideas.
- Output:

[ANSWER] SUMMARY-2,4,6
[WHY]
SUMMARY: 2,4,6
(한국어로 2~5줄: 왜 이 세 문장이 지문의 핵심 요지를 가장 잘 대표하는지, 다른 후보들은 왜 덜 중요한지 설명)

(5) Table / classification (Complete the table, categorize statements)
- There may be 2 or 3 categories (columns) with titles, and several statements below to drag into each category.
- Assume statements are numbered 1..N in their order of appearance, and you infer reasonable category names from the text.
- Output:

[ANSWER]
TABLE:
Category1: 1,3
Category2: 2,4
(필요시 Category3도 같은 형식으로)

[WHY]
TABLE: Category1 -> 1,3 / Category2 -> 2,4
(한국어로 2~5줄: 각 번호 문장이 왜 그 범주에 속하는지 간단하게 정리)

Fallback:
- Only if you truly cannot classify the item type or cannot prefer any option at all, use:

[ANSWER] ?
[WHY]
(한국어로: 정보 부족으로 판단 불가임을 설명)

Strictly follow these tag names and structure:
- EXACTLY ONE [ANSWER] block and ONE [WHY] block.
- Do not introduce additional tags other than [ANSWER] and [WHY].
- Put all Korean explanation only under [WHY].
`;
  }

  // ---------- LISTENING ----------
  if (mode === "listening") {
    return `
You are a TOEFL iBT Listening answer engine for the modern (internet-based) test.

You will receive:

<Listening transcript from audio STT (may contain minor recognition errors)>
${stt}

<On-screen question text and instructions (may include "Select 2 answers", "Complete the chart", etc.)>
${passage}

<Options text (1~4, possibly with multiple correct answers or classification)>
${question}

Your job:
1) Infer the item type:
   - Single-answer 4-option multiple choice
   - Multiple-answer 4-option multiple choice ("Select TWO answers")
   - Table/chart matching (classify statements into categories or steps)
2) Give the answer in a format that matches the item type, using one [ANSWER] block and one [WHY] block.

General confidence rule:
- Consider that the transcript may have small errors, but you should still choose answers when there is ANY reasonable evidence (≈ 20%+ confidence).
- Only use "[ANSWER] ?" when there is truly no way to prefer any option.

FORMATS
=======

(1) Single-answer 4-option multiple choice
- Map options from top to bottom to 1–4.
- Output:

[ANSWER] 3
[WHY]
(한국어 2~5줄: 리스닝 내용과 연결하여 왜 3번이 정답인지 설명)

(2) Multiple-answer 4-option multiple choice
- If instructions say "Select 2 answers" or similar, choose 2 numbers.
- Output:

[ANSWER] 1,4
[WHY]
(한국어 2~5줄: 두 번호 모두 정답인 이유, 다른 보기와 어떻게 다른지 설명)

(3) Table / chart matching
- If the question is clearly asking to match statements to categories or steps:
- Assume statements are numbered 1..N in order.
- Infer reasonable category names from the text.
- Output:

[ANSWER]
TABLE:
Category1: 1,3
Category2: 2,4

[WHY]
TABLE: Category1 -> 1,3 / Category2 -> 2,4
(한국어 2~5줄: 각 번호가 왜 그 범주/단계에 들어가는지 요약)

Fallback:
- Only if you cannot prefer any option(s) at all:

[ANSWER] ?
[WHY]
(한국어로: 정보 부족으로 판단 불가임을 설명)

Strict:
- EXACTLY ONE [ANSWER] block and ONE [WHY] block.
- Do not use other tags.
`;
  }

  // ---------- WRITING ----------
  if (mode === "writing") {
    return `
You are a TOEFL iBT Writing essay generator for the current test (Integrated + Academic Discussion style).

Inputs (some may be empty):
<Reading passage or notes (for integrated tasks)>
${passage}

<On-screen writing prompt text (topic, question, or instructions)>
${question}

<Spoken prompt from audio STT (if any)>
${stt}

Use whatever information is available above to understand the writing task.

Task:
1) Write a TOEFL-style essay based on the given information.
   - Length: STRICTLY 250~320 words.
   - Clear structure with introduction, 2 body paragraphs, and conclusion.
   - Good task achievement, organization, development, vocabulary, and grammar.
2) After the essay, provide Korean feedback (3~5 lines) commenting on:
   - 구조 (introduction/body/conclusion)
   - 내용 및 아이디어
   - 문법/표현의 강점과 개선점

Output Format (STRICT):
[ESSAY]
(essay here, 250~320 words)

[FEEDBACK]
(한국어 피드백 3~5줄)
`;
  }

  // ---------- SPEAKING ----------
  if (mode === "speaking") {
    return `
You are a TOEFL iBT Speaking evaluator for the current 4-task format.

Inputs:
<Question text from screen/OCR (may indicate independent or integrated task)>
${question}

<Extra passage or notes (for integrated tasks, may be empty)>
${passage}

<My spoken answer (STT transcription; may contain small errors)>
${stt}

Assume:
- This is a TOEFL iBT Speaking response with about 45 seconds of speaking.
- A natural model answer should be about 90–120 words (do NOT exceed 130 words).

Task:
1) Evaluate the student's answer in English using TOEFL Speaking criteria:
   - Delivery (pronunciation, intonation, pacing)
   - Language use (grammar, vocabulary)
   - Topic development (organization, coherence, detail)
2) Mention specific strengths and weaknesses and give an approximate level (e.g., High, Mid, Low).
3) Provide a 45–60 second model answer in English (about 90–120 words).
4) Finally, give a short Korean summary and improvement tips (3–5 lines).

Output Format (STRICT):
[EVAL]
(English evaluation: delivery, language use, topic development, approximate level)

[MODEL]
(45–60 second model answer in English, about 90–120 words)

[KOREAN]
(한국어 요약 및 개선 팁 3~5줄)
`;
  }

  // fallback
  return "Invalid mode. Use reading / listening / writing / speaking.";
}

// ---------------- SHORT TTS EXTRACTOR ----------------

function extractTTS(mode, text) {
  // Reading/Listening: 단일정답/복수정답 숫자만 있으면 TTS, 나머지는 null
  if (mode === "reading" || mode === "listening") {
    const m = text && text.match(/\[ANSWER\]\s*([^\n\r]+)/i);
    if (!m) return null;
    const raw = m[1].trim(); // 예: "2", "2,4", "SUMMARY-2,4,6" 등

    // 단일 숫자만 있을 때
    const single = raw.match(/^\s*([1-5])\s*$/);
    if (single) {
      return `The correct answer is number ${single[1]}.`;
    }

    // 쉼표로 구분된 복수 숫자일 때
    const multi = raw.match(/^\s*([1-5])\s*,\s*([1-5])\s*$/);
    if (multi) {
      return `The correct answers are numbers ${multi[1]} and ${multi[2]}.`;
    }

    // 그 외(INSERT, SUMMARY, TABLE 등)는 TTS 생략
    return null;
  }

  if (mode === "speaking") {
    return "Here is your speaking evaluation summary.";
  }
  return null;
}
