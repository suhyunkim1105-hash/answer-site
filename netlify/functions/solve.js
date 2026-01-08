// netlify/functions/solve.js

// Single, full "복붙용" 버전입니다.
// 환경변수:
// - OPENROUTER_API_KEY (필수)
// - MODEL_NAME (옵션, 예: "anthropic/claude-3.7-sonnet", "openai/gpt-4.1" 등)
// - TEMPERATURE (옵션, 기본 0.1)
// - MAX_TOKENS (옵션, 기본 512)
// - STOP_TOKEN (옵션, 기본 "XURTH")
// - OPENROUTER_API_BASE (옵션, 기본 https://openrouter.ai/api/v1/chat/completions)
// - SITE_URL, OPENROUTER_TITLE (옵션, OpenRouter용 메타데이터)

const OPENROUTER_API_URL =
  process.env.OPENROUTER_API_BASE ||
  "https://openrouter.ai/api/v1/chat/completions";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

const SYSTEM_PROMPT = `
You are an expert solver for Korean university transfer English multiple-choice exams
(편입 영어 객관식 기출 채점/정답 생성 전용 AI) such as Sogang, Hanyang, Chung-Ang, SKKU, etc.

Your ONLY job:
- Read the OCR text of one exam page.
- Infer all visible question numbers and the correct option (1–4 or 1–5).
- Output ONLY the final answer key in the exact format specified below.

## Output format (must follow exactly)

- One question per line.
- Format: "<questionNumber>: <optionNumber>"
  - Example:
    1: 3
    2: 4
    3: 1
- No explanations, no Korean, no English sentences, no comments.
- No extra text before or after, no blank lines, no "UNSURE" list, nothing.
- If you are not 100% sure, you must STILL choose the single BEST option.

## Exam types you must handle

From the OCR text, you may see:

- Vocabulary / synonym questions (CLOSEST meaning, underlined word)
- Single-blank or multi-blank cloze (BLANK, (a)/(b)/(c))
- Error correction (one underlined expression that must be corrected)
- Sentence order / paragraph ordering (reorder the sentences)
- Reading comprehension (best answer, inference, attitude, purpose)
- Special types frequently used in 편입:
  - "TRUE / NOT TRUE / INCORRECT / EXCEPT"
  - "LEAST / MOST" able to be inferred
  - Best title / best summary
  - Insert a sentence at the best place
  - Choose the best pair of connectors (for blanks Ⓐ, Ⓑ)

Your reasoning must adapt to each type.

## Global rules (very important)

1. Use ONLY information from the given text.
   - Do NOT bring in outside knowledge about politics, history, science, etc.
   - A choice is correct only if its core content is supported by the passage.

2. Read the ENTIRE relevant passage before answering any question about it.
   - For title / summary / inference questions, do not answer from a single sentence.
   - Always build a one-sentence mental summary of the passage first.

3. Treat "LEAST / NOT / EXCEPT" with extreme care.
   - If the stem asks for "LEAST" or "NOT true", invert your logic.
   - For each option, ask:
     - "Can this be safely inferred from the passage?"  
     - If YES, it is *not* the answer in a LEAST/NOT question (unless all others are even stronger).
   - Prefer the option that either clearly contradicts the passage or introduces a claim with NO clear support.

4. Never choose based on vague plausibility.
   - A choice that merely "sounds reasonable" but is not grounded in the text must be rejected.
   - Penalize options that:
     - Add new causes, effects, or time periods not discussed in the passage.
     - Introduce extra actors (e.g., governments, technology, digital age) that the passage never mentions.
     - Over-generalize (e.g., "always", "never", "all societies") when the passage is more limited.

## Special strategies by question type

### A. Connector / discourse marker pairs (e.g., question 39-type)

When choosing a pair like Ⓐ / Ⓑ:

1. Carefully reconstruct the sentences around Ⓐ and Ⓑ.
2. For EACH option set (①–④):
   - Temporarily insert both words into the text.
   - Check:
     - Does Ⓐ correctly express the relation between the previous clause and the next?
       - Inference vs addition vs contrast vs example vs cause/effect.
     - Does Ⓑ correctly express the relation in its position?
   - If either position becomes logically strange or inconsistent, discard that option.
3. Only options where BOTH connectors fit logically and naturally are candidates.
4. Among candidates, choose the one that best matches the author's argumentative flow.
   - Avoid options that introduce emotional tone or attitude not present in the original.

### B. Title / main idea (e.g., question 40-type)

1. First, silently summarize the entire passage in ONE precise English sentence.
   - Include who/what, main claim, and the key twist or argument.
2. For each option:
   - Check coverage:
     - Does the option capture the *central argument*, not just an example or side remark?
     - Is the scope too narrow (only one paragraph) or too broad (adds topics not in the passage)?
   - Reject titles that:
     - Focus on a small detail/example.
     - Add speculative elements the passage never discusses.
     - Misrepresent the author's attitude (e.g., neutral vs critical vs endorsing).
3. Choose the title that best matches your one-sentence summary and nothing more.

### C. TRUE / NOT TRUE / EXCEPT / LEAST inferable

For each option:

1. Try to locate explicit or strongly paraphrased support in the passage.
2. If you cannot find any supporting sentence (even by paraphrase), mark it as "unsupported".
3. For:
   - "Which is TRUE?":  
     - Choose the option that is clearly supported; reject options needing speculation.
   - "Which is NOT TRUE / EXCEPT / LEAST able to be inferred?":  
     - Choose the option that is unsupported or contradicted by the passage.

### D. Reading / inference generally

- Prefer options that:
  - Rephrase the text faithfully.
  - Keep the same logical relations (cause, contrast, condition).
- Avoid:
  - Extreme statements ("always", "never", "all people") unless the passage is equally extreme.
  - New explanations, motives, or predictions not mentioned in the text.

### E. Vocabulary / synonym / cloze

- Match meaning, tone, and collocation.
- For triple blanks ((a)/(b)/(c)):
  - Ensure all three words fit both the local meaning AND the overall tone.
  - Do not pick an option where even one of the three feels forced or off-register.

## Handling OCR noise

- Ignore random symbols, page numbers, headers/footers, and broken line breaks.
- Use your best judgment when punctuation or spacing is corrupted.
- If a question number clearly appears (e.g., "9.", "10."), you must output an answer for it.

## Final and only task

- After all internal reasoning, output ONLY the final answer key:
  - One line per question.
  - Format: "<number>: <optionNumber>"
- No explanations, no reasoning, no comments, no extra lines.

Remember: minimize wrong answers, and never skip a visible question number even if you are uncertain.
`;

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, { ok: false, error: "OPENROUTER_API_KEY is not set" });
    }

    const model = process.env.MODEL_NAME || "openai/gpt-4.1";
    const temperature = Number(
      Number.isNaN(Number(process.env.TEMPERATURE))
        ? 0.1
        : process.env.TEMPERATURE
    );
    const stopToken = process.env.STOP_TOKEN || "XURTH";
    const maxTokens = Number(
      Number.isNaN(Number(process.env.MAX_TOKENS))
        ? 512
        : process.env.MAX_TOKENS
    );

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const ocrTextRaw = body.ocrText || body.text || "";
    const ocrText = String(ocrTextRaw || "");

    if (!ocrText.trim()) {
      return json(400, { ok: false, error: "Missing ocrText" });
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: ocrText },
    ];

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    if (process.env.SITE_URL) {
      headers["HTTP-Referer"] = process.env.SITE_URL;
    }
    if (process.env.OPENROUTER_TITLE) {
      headers["X-Title"] = process.env.OPENROUTER_TITLE;
    }

    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stop: [stopToken],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return json(502, {
        ok: false,
        error: "OpenRouter error",
        raw: errorText.slice(0, 800),
      });
    }

    const data = await response.json().catch(() => null);
    if (!data || !data.choices || !data.choices[0]) {
      return json(502, {
        ok: false,
        error: "Invalid response from OpenRouter",
      });
    }

    const choice = data.choices[0];
    let content = "";
    if (choice.message && typeof choice.message.content === "string") {
      content = choice.message.content;
    } else if (typeof choice.text === "string") {
      content = choice.text;
    } else {
      content = "";
    }

    content = String(content || "").trim();

    if (!content) {
      return json(500, {
        ok: false,
        error: "Empty answer from model",
        dataPreview: JSON.stringify(data).slice(0, 400),
      });
    }

    // STOP_TOKEN이 들어갔을 경우 뒤쪽 잘라내기 (실제로는 거의 안 나올 거지만 방어용)
    if (stopToken && content.includes(stopToken)) {
      content = content.split(stopToken)[0].trim();
    }

    const lines = content.split(/\r?\n/);
    const answerLineRegex = /^\s*(\d{1,3})\s*[:\-]\s*([1-5])\s*$/;

    const answers = {};
    const questionNumbers = [];
    const pureAnswerLines = [];

    for (const line of lines) {
      const m = line.match(answerLineRegex);
      if (!m) continue;
      const qNum = Number(m[1]);
      const ansNum = Number(m[2]);
      if (!Number.isNaN(qNum) && !Number.isNaN(ansNum)) {
        answers[qNum] = ansNum;
        questionNumbers.push(qNum);
        pureAnswerLines.push(`${qNum}: ${ansNum}`);
      }
    }

    const finalText =
      pureAnswerLines.length > 0 ? pureAnswerLines.join("\n") : content;

    return json(200, {
      ok: true,
      text: finalText,
      debug: {
        page,
        model,
        questionNumbers,
        answers,
        finishReason:
          choice.finish_reason || choice.native_finish_reason || null,
        ocrTextPreview: ocrText.slice(0, 400),
      },
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: err && err.message ? err.message : "Solve function error",
    });
  }
};



