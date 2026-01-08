// netlify/functions/solve.js
// 편입영어 객관식 기출 자동 채점용 solve 함수
// - 입력: { page, ocrText } (또는 { text })
// - 출력: { ok, text: "1: A\n2: D...", debug: { ... } }

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(obj),
  };
}

// 모델 출력에서 "번호: 선택지"만 뽑아서 정리
function parseAnswers(raw) {
  if (!raw) return { questionNumbers: [], answers: {} };

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const answers = {};
  const questionNumbers = [];

  const choiceMapDigitToLetter = {
    "1": "A",
    "2": "B",
    "3": "C",
    "4": "D",
    "5": "E",
  };

  for (const line of lines) {
    // 기대 포맷: "12: A" 또는 "12:A" 또는 "12 - A"
    const m = line.match(/^(\d+)\s*[:\-]\s*([A-E1-5])/i);
    if (!m) continue;

    const qNum = parseInt(m[1], 10);
    let choice = m[2].toUpperCase();

    if (choiceMapDigitToLetter[choice]) {
      choice = choiceMapDigitToLetter[choice];
    }

    if (!["A", "B", "C", "D", "E"].includes(choice)) continue;

    answers[String(qNum)] = choice;
    questionNumbers.push(qNum);
  }

  // 중복 제거 + 정렬
  const uniqNums = Array.from(new Set(questionNumbers)).sort((a, b) => a - b);
  return { questionNumbers: uniqNums, answers };
}

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
    const temperature = Number(process.env.TEMPERATURE ?? 0.0);
    const maxTokens = Number(process.env.MAX_TOKENS ?? 512);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const ocrText = String(body.ocrText || body.text || "").trim();

    if (!ocrText) {
      return json(400, { ok: false, error: "Missing ocrText/text" });
    }

    // ----------------- 프롬프트 (방어용, 시험 전용) -----------------
    const systemPrompt = `
You are an answer-key generator for Korean university transfer English multiple-choice exams.
You receive raw OCR text of one test page, including:
- Question numbers (e.g., 1., 2., 16., 24., 33., etc.)
- Question stems and options (A–E or ①–⑤)
- Section headings like [QUESTIONS 1-4], instructions, etc.

Your ONLY job:
- For EVERY visible question number in the OCR text,
  output EXACTLY one final answer choice.

STRONG RULES:

1) Output format
   - One line per question
   - Format: "<number>: <choice>"
     - Example:
       1: A
       2: D
       3: C
   - <number> is the integer question number (1, 2, 3, ..., 40, etc.).
   - <choice> is a SINGLE letter among A, B, C, D, E.
   - DO NOT output anything else:
     - No explanations
     - No comments
     - No "UNSURE"
     - No extra text above or below

2) Coverage (NO missing questions)
   - Carefully scan the whole OCR text and detect ALL question numbers that truly belong to the page.
   - If a question number appears with a stem and visible choices, you MUST output an answer line for it.
   - Even if the last options are partially cut off, you MUST still choose the BEST guess and output an answer.
   - Never skip a visible, valid question number.

3) Handling NOT / EXCEPT / LEAST / FALSE
   - If the question stem includes words like:
     - NOT, EXCEPT, LEAST, FALSE, INCORRECT, WRONG
   - Then you must:
     - First, decide what the passage or stem is actually claiming.
     - Eliminate options that are clearly supported or correct.
     - Choose the option that is MOST inconsistent, least supported, or clearly false.
   - In these problems, do NOT just pick the option that sounds most related.
   - Specifically for "LEAST" / "NOT" / "EXCEPT" questions, the correct answer is the option that does NOT match the main idea or evidence.

4) Inference and passage questions (like Q24–Q40 in Sogang-type exams)
   - For questions asking about the author’s attitude, purpose, or the type of text:
     - “editorial” → argumentative about current issues, strong opinion.
     - “graduate term paper” → formal, analytical, with classification and examples.
     - “avant-garde artist statement” → experimental, subjective, breaking norms.
     - “ethnologist / cultural theory” → describing and analyzing patterns across cultures or societies.
   - Always choose the option that best matches what the passage is DOING overall, not just one sentence.

5) Last questions of a passage
   - For the final questions of each passage (e.g., 33–40):
     - Re-check the passage’s overall theme, structure, and tone.
     - Prefer options that fit the global logic of the whole passage.
     - Avoid options that are too extreme (always/never) unless the passage itself is extreme.

6) Ambiguous / partial OCR
   - If some words are broken or noisy due to OCR, infer the most likely original phrase from context.
   - Still pick the single best answer for each question number.

7) Choices mapping
   - If options appear as ①②③④⑤ (or 1,2,3,4,5), convert them internally:
     1 → A, 2 → B, 3 → C, 4 → D, 5 → E
   - Your final output must ALWAYS use letters A–E.

Remember:
- Your final output must be ONLY the answer map lines,
  one per question, in ascending order of question number.
`;

    const userPrompt = `
Here is the raw OCR text of one exam page.

OCR TEXT (page ${page}):
--------------------------------------------------
${ocrText}
--------------------------------------------------

Now:
- Detect every question number that belongs to this page.
- For each detected question number, choose the single best answer.
- Output ONLY lines in the format "<number>: <choice>" (e.g., "16: B").
- Sort lines by question number in ascending order.
`;

    // ----------------- OpenRouter 호출 -----------------
    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer":
          process.env.OPENROUTER_REFERRER ||
          "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site-solve",
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt.trim() },
          { role: "user", content: userPrompt.trim() },
        ],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return json(502, {
        ok: false,
        error: `OpenRouter request failed: ${resp.status}`,
        detail: text.slice(0, 500),
      });
    }

    const data = await resp.json().catch(() => null);
    const choice = data && data.choices && data.choices[0];
    const content =
      choice && choice.message && typeof choice.message.content === "string"
        ? choice.message.content.trim()
        : "";

    if (!content) {
      return json(500, {
        ok: false,
        error: "Empty answer from model",
        dataPreview: JSON.stringify(data || {}, null, 2).slice(0, 500),
      });
    }

    const { questionNumbers, answers } = parseAnswers(content);

    // 최종 text (정답맵 그대로)
    const finalText = questionNumbers
      .map((n) => `${n}: ${answers[String(n)]}`)
      .join("\n");

    return json(200, {
      ok: true,
      text: finalText,
      debug: {
        page,
        model,
        questionNumbers,
        answers,
        finishReason: choice.finish_reason || choice.native_finish_reason || "",
        ocrTextPreview: ocrText.slice(0, 500),
      },
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "solve internal error",
      detail: String(err && err.message ? err.message : err),
    });
  }
};
