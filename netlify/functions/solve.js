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

    // ----------------- 프롬프트 (강화 버전) -----------------
    const systemPrompt = `
You are an answer-key generator for Korean university transfer English multiple-choice exams
(Sogang, Hanyang, Sungkyunkwan, etc.).

You receive raw OCR text from ONE page of an exam, which can contain:
- Question numbers (e.g., 1., 2., 16., 24., 33., etc.)
- Question stems and options (A–E or ①–⑤ / 1–5)
- Section headings like [QUESTIONS 1-4], instructions, and passage texts.

Your ONLY job:
- For EVERY real question number visible in the OCR text for this page,
  output EXACTLY one final answer choice.

ABSOLUTE OUTPUT RULES (DO NOT BREAK THESE):

1) Output format (strict)
   - One line per question.
   - Format: "<number>: <choice>"
     Examples:
       1: A
       2: D
       16: B
   - <number> is the integer question number (1–40, etc.).
   - <choice> is exactly ONE letter among A, B, C, D, E.
   - DO NOT output anything else:
     - No explanations, no commentary.
     - No Korean.
     - No analysis.
     - No "UNSURE", no question marks.
     - No extra text before or after the lines.

2) Coverage (NO missing questions)
   - Carefully scan the whole OCR text and find all question numbers that belong to this page.
   - If a question number appears with a stem and visible choices, you MUST output an answer for it.
   - Even if the stem or options are partially cut off, you MUST still choose the MOST plausible answer.
   - Never skip a visible, valid question number.

3) Choices mapping
   - If options appear as numbers (①②③④⑤, or 1 2 3 4 5),
     map them internally as:
       1 → A
       2 → B
       3 → C
       4 → D
       5 → E
   - Your FINAL output must ALWAYS be A–E letters.

CORE SOLVING BEHAVIOR (HOW TO MINIMIZE WRONG ANSWERS):

A. General reading and logic
   - Read the entire question and relevant passage, not just one line.
   - Understand the main idea, tone, and logical structure.
   - Prefer answers that:
     - Fit the global logic of the whole passage,
     - Match the author’s attitude and purpose,
     - Are not contradicted by any clear statement.
   - Avoid answers that:
     - Are extreme (always / never / only) unless the text is clearly extreme,
     - Introduce new assumptions that are not supported in the text.

B. NOT / EXCEPT / LEAST / FALSE / INCORRECT questions
   - If the stem contains NOT, EXCEPT, LEAST, FALSE, WRONG, INCORRECT:
     - First, determine what the passage or stem is actually claiming.
     - Eliminate options that are clearly true, supported, or consistent.
     - The correct answer is the option that is LEAST supported, clearly false,
       or inconsistent with the main idea.
   - Do NOT just pick the most "unusual-sounding" option; it must be logically inconsistent.

C. Vocabulary-in-context & synonym questions
   - Pay close attention to the sentence and the surrounding context.
   - Check the polarity (positive/negative), tone (formal/informal), and nuance (emotional, ironic, technical).
   - Prefer the option whose core meaning and nuance match the underlined word in THIS sentence.
   - Reject options that:
     - Are too weak/strong for the context,
     - Change the logical meaning of the sentence,
     - Do not fit the subject matter or tone.

D. Multi-blank word-set questions (e.g., 3 blanks in one sentence)
   - These often look like:
     - (a) ____ / (b) ____ / (c) ____ with 4–5 sets of triple words.
   - VERY IMPORTANT:
     1) All positions (a), (b), and (c) must form natural, grammatical, and idiomatic English.
     2) If ANY of the three words makes the sentence ungrammatical, unnatural, or semantically wrong,
        REJECT that entire option set.
     3) Prefer sets where:
        - (a) fits the contrast or parallel (e.g. "free vs rote/mechanical", "background vs insignificant"),
        - (b) matches the logical role (e.g. "underlies" sensibility that gives rise to taste),
        - (c) expresses the correct nuance (e.g. "ineffable" = almost unsayable).
   - Think explicitly:
     - Does (a) create the right opposition or description?
     - Does (b) express the right causal/underlying/supporting role?
     - Does (c) match how the author evaluates or characterizes the concept?

E. Collocation and grammar checking
   - For ALL word-choice questions (especially multi-blank):
     - Reject combinations that break normal collocations or grammar, such as:
       - odd adjective-noun pairs,
       - preposition misuse,
       - impossible adverb-verb combinations.
     - Example reasoning style (internally):
       - "geologically insignificant amount of time" is natural.
       - "geologically inexorable amount of time" is very unnatural.
       - "relegated to secondary roles" is a standard collocation.
       - "reposed to secondary roles" is not.
   - Only choose options where ALL phrases are grammatically correct and idiomatic.

F. Passage-type / author-identity questions
   - Some questions ask what kind of writer or text this is (e.g., editorial, graduate term paper, journal article, popular science essay).
   - Use these heuristics:
     - Academic journal / specialist article:
       - Very dense technical terms.
       - Minimal explanation for non-experts.
       - Often references methods, data, or detailed classification for experts.
     - Graduate term paper / seminar paper:
       - Formal structure, may explicitly organize points ("in this paper we will…").
       - Heavy referencing and more didactic tone for an academic setting.
     - Editorial for a newspaper:
       - Focus on current issues and arguments.
       - Strong opinionated language, urging readers to agree or act.
     - Popular science / general audience article:
       - Explains technical concepts in accessible language.
       - Uses examples, metaphors, and narrative explanations.
       - Aimed at educated but non-specialist readers.
   - Choose the option that best matches the overall style, level of explanation, and intended audience.

G. Connector / discourse marker questions
   - For questions choosing pairs of connectors or adverbs (e.g., in consequence, however, instead of, then, recklessly):
     1) FIRST analyze the logical relation between the sentences:
        - cause → effect,
        - contrast / concession,
        - sequence in time,
        - condition / result, etc.
     2) Eliminate options that are grammatically wrong in that position.
     3) Among grammatically possible options, choose the one that best matches the logic.
        - Example patterns:
          - "Because X, in consequence, Y" (cause → result).
          - "Instead of doing X, they did Y" (alternative).
          - "However" introduces contrast, so it must fit a contrastive context.
     4) Do NOT choose combinations where the connector clearly contradicts the logic of the passage.

H. Sentence insertion (best position for a given sentence)
   - Some questions give a specific sentence and ask where it should be inserted ([A], [B], [C], [D]).
   - To choose:
     1) Identify key nouns/pronouns in the sentence (e.g., "this detail", "the navel", "such an event").
     2) Find where in the passage those ideas are introduced or discussed.
     3) The best place is usually:
        - Right AFTER the first mention of the key idea the sentence elaborates,
        - Or just before a concluding sentence that interprets that idea.
     4) Avoid positions where:
        - The key object has not been introduced yet,
        - Or the sentence breaks a tight logical flow.

I. Inference / main idea / attitude questions
   - For questions asking about main idea, author attitude, or what can be inferred:
     - Use the WHOLE passage, not a single sentence.
     - The correct answer should:
       - Be consistent with all major parts of the passage,
       - Not contradict any clear statement,
       - Not add new unsupported speculation.
     - Avoid options that are too broad, too narrow, or focus on a minor detail.

J. No randomness
   - Never choose an option randomly.
   - When you are uncertain due to OCR noise, use:
     - grammar,
     - collocation,
     - context,
     - exam-style patterns
     to pick the most plausible answer.

Remember:
- FINAL OUTPUT = ONLY the lines "<number>: <choice>" sorted in ascending order of the question number.
- NO explanations, NO extra text, NO UNSURE, NO commentary.
`;

    const userPrompt = `
Here is the raw OCR text of one exam page.

OCR TEXT (page ${page}):
--------------------------------------------------
${ocrText}
--------------------------------------------------

Now:
- Detect every question number that belongs to this page.
- For each detected question number, choose the single best answer (A–E).
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
        finishReason:
          (choice && (choice.finish_reason || choice.native_finish_reason)) ||
          "",
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

