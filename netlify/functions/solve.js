// netlify/functions/solve.js
// 편입 영어 객관식 기출 전용 정답 생성 함수.
// - env: OPENROUTER_API_KEY (필수)
// - env: MODEL_NAME (옵션, 기본 openai/gpt-4.1)
// - env: TEMPERATURE (옵션, 기본 0.1)
// - env: SOLVE_MAX_TOKENS (옵션, 기본 512)
// - env: STOP_TOKEN (옵션, 있으면 stop 시그널로만 사용. 출력에는 절대 쓰지 말 것.)

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    },
    body: JSON.stringify(obj)
  };
}

async function callOpenRouter(messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const model = process.env.MODEL_NAME || "openai/gpt-4.1";
  const temperature = Number(
    Number.isFinite(Number(process.env.TEMPERATURE))
      ? process.env.TEMPERATURE
      : 0.1
  );
  const maxTokensEnv = Number(process.env.SOLVE_MAX_TOKENS);
  const maxTokens = Number.isFinite(maxTokensEnv) && maxTokensEnv > 0
    ? maxTokensEnv
    : 512;

  const stopToken = process.env.STOP_TOKEN || "";

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens
  };

  if (stopToken) {
    // 출력에서 stopToken을 넣지 말고, 여기서만 컷하는 용도로 사용.
    body.stop = [stopToken];
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "answer-site"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`OpenRouter HTTP ${res.status}`);
  }

  const data = await res.json();
  return data;
}

function parseAnswers(rawText) {
  const lines = (rawText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const answers = {};
  const questionNumbers = [];

  const lineRe = /^(\d{1,3})\s*[:\-\.]?\s*([A-E])/i;

  for (const line of lines) {
    const m = line.match(lineRe);
    if (!m) continue;
    const qn = Number(m[1]);
    const letter = m[2].toUpperCase();
    if (!Number.isNaN(qn)) {
      answers[qn] = letter;
      questionNumbers.push(qn);
    }
  }

  return { answers, questionNumbers };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json(200, { ok: true });
  }
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "POST only" });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  const ocrText = String(body.ocrText || body.text || "").trim();
  const page = body.page ?? null;

  if (!ocrText) {
    return json(400, { ok: false, error: "ocrText is required" });
  }

  const systemPrompt = `
You are a professional multiple-choice exam solver for Korean university transfer exams
(편입 영어 객관식). Your ONLY job is to read the OCR text of an exam page and output
a clean answer key.

The input:
- A single long string with the full OCR text of ONE exam page.
- It includes question numbers, questions, and options.
- Question numbers appear as patterns like:
  "1.", "1)", "1 :", "1 -", or at the start of a line.
- Options can be:
  - A, B, C, D, E
  - (A), (B), (C) ...
  - ① ② ③ ④ ⑤  or 1) 2) 3) 4) 5)
- The exam may include English instructions, school names (e.g. SOGANG UNIVERSITY),
  page headers, etc. You must IGNORE all non-question noise.

Your goals (strict priority order):
1) Minimize wrong answers.
2) Absolutely ZERO question-number omissions: if a question number is visible in the OCR,
   you must output AN answer for it (best guess allowed, but no blanks).
3) Output FORMAT must be extremely strict:
   - Each line: "<question-number>: <letter>"
   - Example:
       1: A
       2: D
       3: C
   - No extra text, no explanations, no headers, no comments, no "UNSURE", no punctuation
     other than the colon after the number.
   - DO NOT output anything else.

How to think (internal steps, DO NOT print these steps):

0) Question number detection
   - Scan the OCR text line-by-line and detect question numbers by patterns like:
       line starts with "number." or "number)" or "number :" etc.
   - Treat each detected number as the start of a "question block" that continues
     until the next detected question number.
   - Only use question numbers that ACTUALLY appear in the OCR text. Do NOT hallucinate
     numbers that are not present.

1) Block-level solving
   - For each question block:
     - Read the stem and all options.
     - Identify which options are the choices.
     - Convert options into letters A–E:
       * If options are written as (A)(B)..., keep letters.
       * If options are numbered 1–5 (e.g., ① ② ③ ④ ⑤), map them to letters:
         1 → A, 2 → B, 3 → C, 4 → D, 5 → E.
     - Solve the question using normal exam reasoning.

2) Special handling of tricky question types
   - Error correction / underlined parts:
     * Often options like A. B. C. D. correspond to underlined segments.
     * Choose the segment that is ungrammatical, unacceptable, or incorrect,
       according to the stem.
   - Reordering / sequence questions:
     * Options such as "A-B-C-D", "C-D-A-B" etc. require ordering sentences.
   - Vocabulary / closest meaning:
     * Focus on the main target word and match the best synonym.

3) Critical rules for LEAST / EXCEPT / NOT / FALSE
   - If the stem includes words like **NOT, EXCEPT, LEAST, FALSE**:
     * First identify what the passage or stem is clearly SUPPORTING.
     * Eliminate options that are consistent with the passage.
     * Choose the option that is MOST inconsistent or LEAST supported,
       even if all options look partially related.
   - Be extra careful: do NOT choose the "most plausible" sentence overall.
     Choose the one that is LEAST supported when the question asks for LEAST/EXCEPT/NOT.

4) Text-type / author-type questions (e.g. "The author's presentation is MOST like that of:")
   - Use the overall behavior of the passage:
     * "editorial": argumentative, about current affairs, strong opinion.
     * "term paper": formal, structured, analytic, with classification/examples.
     * "avant-garde artist": experimental, subjective, trying to shock or innovate.
     * "ethnologist / cultural theorist": analyzing cultural patterns, societies,
       "old vs new", "national literature", etc.
   - Decide which description best matches WHAT THE PASSAGE IS DOING overall.

5) Last few questions in a passage (global questions: tone, main idea, structure)
   - Always reconsider the entire passage:
     * Re-read the first sentence and the last sentence.
     * Summarize the main theme and tone.
     * Reject options that are too extreme (always, never, completely) unless
       the passage itself is that extreme.
   - Choose the option that fits the global logic and tone, not just one sentence.

6) Output formatting (VERY IMPORTANT)
   - For every detected question number, output exactly ONE line:
       "<question-number>: <letter>"
   - The letter must be in A–E only.
   - If the question has only 4 options (A–D), you can only choose A, B, C, or D.
   - If you are unsure, still choose the BEST GUESS and do NOT mark it as unsure.
   - DO NOT output any explanations, analysis, or extra lines.
   - DO NOT output "UNSURE" or "?".
   - DO NOT output the stop token, if any.

If you follow all of the above, you will minimize wrong answers and avoid missing
any question numbers, which is critical for high exam scores.
`;

  const userPrompt = ocrText;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];

  try {
    // 1차 호출
    let data = await callOpenRouter(messages);

    let choice =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message;

    let rawText = (choice && choice.content && choice.content.trim()) || "";

    // 혹시라도 비어 있으면 1번만 재시도 (다른 모델/설정은 유지)
    if (!rawText) {
      data = await callOpenRouter(messages);
      choice =
        data &&
        data.choices &&
        data.choices[0] &&
        data.choices[0].message;
      rawText = (choice && choice.content && choice.content.trim()) || "";
    }

    if (!rawText) {
      return json(500, {
        ok: false,
        error: "Empty answer from model"
      });
    }

    const { answers, questionNumbers } = parseAnswers(rawText);

    // 한 개도 못 파싱했으면 에러로 취급 (프롬프트/모델 튜닝 필요)
    if (!questionNumbers.length) {
      return json(500, {
        ok: false,
        error: "No answers parsed from model output",
        raw: rawText.slice(0, 400)
      });
    }

    const modelName = data && data.model;
    const finishReason =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].finish_reason;

    return json(200, {
      ok: true,
      text: rawText,
      debug: {
        page,
        model: modelName,
        questionNumbers,
        answers,
        finishReason,
        ocrTextPreview: ocrText.slice(0, 400)
      }
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: err.message || "Unexpected solve error"
    });
  }
};
