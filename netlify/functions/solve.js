// netlify/functions/solve.js
// 편입 영어 객관식 기출 채점용 solve 함수 (전 기출 공용 방어 프롬프트 버전)

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, {
        ok: false,
        error: "OPENROUTER_API_KEY is not set",
      });
    }

    const model = process.env.MODEL_NAME || "anthropic/claude-3.7-sonnet";
    const stopToken = process.env.STOP_TOKEN || "XURTH";
    const temperature = Number(process.env.TEMPERATURE ?? 0);

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const ocrTextRaw = String(body.ocrText || body.text || "");
    const ocrText = ocrTextRaw.replace(/\r/g, "");

    if (!ocrText.trim()) {
      return json(400, { ok: false, error: "Missing ocrText" });
    }

    // ===== 프롬프트 =====
    const systemPrompt = `
You are an AI grader for Korean university transfer English multiple-choice exams.
Your ONLY job is to generate the answer key from OCR text of the test paper.

[Exam context]
- Exams are for various Korean universities (Sogang, Hanyang, CAU, SKKU, etc.), all years.
- Question types may include:
  - vocabulary / closest meaning
  - sentence completion / fill in the blank
  - error detection (one underlined expression must be corrected)
  - sentence ordering / paragraph ordering
  - reading comprehension, inference, main idea, title, attitude, EXCEPT/NOT/LEAST
- Answer options are usually labeled with capital letters A, B, C, D, and sometimes E.

[Your input]
- You receive OCR text which may include:
  - university name, year, score table, section titles
  - question numbers, stems, passages, and options (A/B/C/D/E)
  - some OCR noise, line breaks, or minor mis-recognition
- All pages of one test may be included in a single input.

[Your task]
1. Read ALL OCR text first. Do NOT answer before you have mentally scanned the entire input.
2. For every visible question number, choose exactly ONE answer option.
   - Use the letter printed in the options: A, B, C, D, or E (if E exists).
   - Never output numbers like 1/2/3/4; always output letters.
3. Even if a question is partially cut, slightly noisy, or the options look similar, you MUST still choose the best answer.
   - Skipping, leaving blank, or writing "unknown" is NOT allowed.
   - If you are uncertain, choose the option that is most consistent with the passage, grammar, and normal exam logic.
4. Output FORMAT (this is VERY STRICT):
   - One question per line.
   - Each line: "<questionNumber>: <capitalLetter>"
     Examples:
       1: A
       2: D
       16: B
       29: E
   - Question numbers must be in ascending order.
   - Do NOT output anything else: no explanations, no comments, no UNSURE list, no extra text.
   - Do NOT output the stop token "${stopToken}" anywhere.

[Type-specific rules]

(1) Vocabulary / closest meaning
- Choose the option whose meaning is closest to the underlined word in context.
- Consider nuance and connotation. Ignore options that are technically related but wrong in the sentence context.

(2) Sentence completion / blank filling
- Choose the option that makes the sentence natural, logical, and consistent with the passage.
- Prefer options that fit BOTH grammar and meaning, not just one of them.

(3) Error detection (one underlined expression must be corrected)
- Identify the SINGLE underlined part that is truly ungrammatical, unacceptable, or clearly wrong in normal educated written English.
- Do NOT mark as wrong:
  - rare but grammatical structures,
  - slightly awkward but acceptable phrases,
  - stylistic or register differences only.
- Focus on clear errors in:
  - agreement, tense, subcategorization (verb + preposition/object), idioms, logical connectors, etc.

(4) Ordering (sentence / paragraph)
- Find the order that creates the most coherent logical flow:
  - introductions → development → examples → conclusion.
- Use time sequence, pronoun reference, connectives, and topic continuity.

(5) Reading comprehension / inference / main idea / title / attitude
- Base your answer ONLY on what the passage explicitly states or strongly implies.
- Do NOT rely on real-world knowledge if it contradicts or extends beyond the passage.
- Be especially careful with EXCEPT / NOT TRUE / LEAST questions:
  - First, decide for each option whether it IS supported by the passage.
  - For NOT/EXCEPT: choose the one that is NOT supported or is contradicted.
  - For LEAST: choose the one LEAST supported by the passage.
- Typical trap options:
  - overgeneralization ("always", "never", "all", "none"),
  - exaggeration of the author's attitude,
  - adding new claims that the passage never mentions,
  - focusing on a minor detail instead of the main point.
  Avoid these when they do not precisely match the passage.

[Important constraints]
- Never invent extra questions or skip visible questions.
- Never change the labeling scheme: if options are A/B/C/D/E, your answers must be A/B/C/D/E.
- Your final output MUST be only the list of answers in the exact format:
  "<number>: <letter>" on each line, ascending order, nothing else.
`.trim();

    const userPrompt = [
      "Below is the OCR text of one entire multiple-choice exam (possibly several pages).",
      "Carefully extract all visible question numbers and their options, then choose the single best answer for each question.",
      "",
      "Remember:",
      "- Use A/B/C/D/E letters, not numbers.",
      "- Do NOT skip any visible question number.",
      "- Do NOT output explanations or comments.",
      "",
      "OCR TEXT START",
      ocrText,
      "OCR TEXT END",
    ].join("\n");

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site-solve",
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: 512,
        stop: [stopToken],
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return json(500, {
        ok: false,
        error: "OpenRouter API error",
        detail: errText.slice(0, 500),
      });
    }

    const data = await response.json();

    const choice = data.choices && data.choices[0];
    const finishReason =
      (choice && (choice.finish_reason || choice.native_finish_reason)) ||
      "unknown";

    let raw = "";
    if (choice && choice.message && typeof choice.message.content === "string") {
      raw = choice.message.content;
    }
    raw = (raw || "").trim();

    // 안전장치: 혹시 모델이 설명을 뱉었을 때를 대비해서 패턴에 맞는 줄만 추출
    const lines = raw
      .split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const answers = {};
    const questionNumbers = [];

    for (const line of lines) {
      const m = line.match(/^(\d+)\s*[:\-]\s*([A-E])/i);
      if (!m) continue;
      const q = Number(m[1]);
      const ans = m[2].toUpperCase();
      if (!questionNumbers.includes(q)) {
        questionNumbers.push(q);
      }
      answers[q] = ans;
    }

    questionNumbers.sort((a, b) => a - b);

    let compactText;
    if (questionNumbers.length > 0) {
      compactText = questionNumbers.map((q) => `${q}: ${answers[q]}`).join("\n");
    } else {
      // 최악의 경우: 모델이 이상한 걸 보냈을 때 raw 그대로 로그에만 남김
      compactText = "";
    }

    if (!compactText) {
      return json(500, {
        ok: false,
        error: "Empty or unparsable answer from model",
        raw,
      });
    }

    return json(200, {
      ok: true,
      text: compactText,
      debug: {
        page,
        model,
        questionNumbers,
        answers,
        finishReason,
        ocrTextPreview: ocrText.slice(0, 400),
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



