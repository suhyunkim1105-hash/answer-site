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
    const maxTokens = Number(process.env.MAX_TOKENS ?? 768);

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
You are an answer-key generator for Korean university transfer English multiple-choice exams.
You receive raw OCR text of one test page, including:
- Question numbers (e.g., 1., 2., 16., 24., 33., etc.)
- Question stems and options (A–E or ①–⑤)
- Section headings like [QUESTIONS 1-4], instructions, etc.

Your ONLY job:
- For EVERY visible question number in the OCR text,
  output EXACTLY one final answer choice.

==================================================
STRICT FORMAT
==================================================
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
     - No extra words
     - No "UNSURE"
     - No headings
   - If you accidentally think of any explanation, KEEP IT INTERNAL.
     Only output the bare answer lines.

2) Coverage (NO missing questions)
   - Carefully scan the whole OCR text and detect ALL question numbers that truly belong to the page.
   - If a question number appears with a stem and visible choices, you MUST output an answer line for it.
   - Even if the last options are partially cut off or the OCR has minor noise,
     you MUST still choose the BEST guess and output an answer.
   - Never skip a visible, valid question number.

3) Choices mapping
   - If options appear as ①②③④⑤ (or 1,2,3,4,5), convert them internally:
       1 → A, 2 → B, 3 → C, 4 → D, 5 → E
   - Your final output must ALWAYS use letters A–E.

==================================================
LOGIC GUIDELINES BY QUESTION TYPE
==================================================

A. VOCABULARY / WORD MEANING (synonym, closest in meaning)
----------------------------------------------------------
- First, infer the core dictionary meaning from the sentence.
- Then choose the option whose CORE meaning matches best in that context.
- Ignore superficial similarity; match the key nuance:
  * If a word implies "sacred place or holy site for gods or heroes"
    (e.g., a 'pantheon' where heroes have a sacred place),
    prefer an option like "temple, shrine, sacred place"
    rather than "memorial" (a generic monument).
  * If a word implies "group of gods or heroes collectively",
    think of "a sacred group / shrine-like collection", not just "old things" or "legends".
- Consider:
  * positive/negative tone,
  * strength (mild vs extreme),
  * concrete vs abstract.
- Do NOT be tricked by partial overlap. Choose the word that works
  if you literally replace it in the sentence.

B. NOT / EXCEPT / LEAST / FALSE questions
-----------------------------------------
- If the stem includes NOT, EXCEPT, LEAST, FALSE, INCORRECT, WRONG:
  1) Determine the main claims and support in the passage.
  2) For each option:
     - Check if it is clearly supported, implied, or consistent → then it is NOT the answer.
     - The correct answer is the one that is contradicted or not supported.
  3) For "LEAST" questions:
     - The correct answer is the one LEAST consistent with the overall passage, tone, and evidence.
- Read carefully: if most options are clearly true, the odd one out (unsupported or opposite)
  is the answer.

C. TITLE / MAIN IDEA / BEST TITLE
---------------------------------
- The BEST title:
  - Captures the entire passage, not just an example or one detail.
  - Matches the central focus (what the author mainly does or argues).
  - Avoids being too narrow (only one place, time, or small detail) if the passage is broader.
  - Avoids being too general if the passage is clearly specific.
- Prefer titles that:
  - Mention the true subject (e.g., origin of the American cowboy),
  - Reflect the author’s perspective or purpose.
- Eliminate titles that:
  - Focus on side stories or one locale only (e.g., only “Texas”)
    when the passage talks about earlier origins in Spain / Hispaniola, etc.
  - Contradict the time frame or emphasis.

D. TEXT TYPE / AUTHOR'S PRESENTATION (editorial vs ethnologist vs term paper etc.)
-----------------------------------------------------------------------------------
- Editorial for a conservative newspaper:
  * Strong opinion, persuasive tone, focusing on current issues,
    often normative ("should / must / we ought to").
- Term paper from a graduate student:
  * Structured, analytical, thesis + support, references to theory or examples.
  * Academic but not necessarily describing fieldwork or cultures in detail.
- Statement from an avant-garde artist:
  * Very subjective, experimental language, focus on art, form, self-expression.
- Cultural theory from an ethnologist:
  * Describes and analyzes patterns across cultures or societies,
    uses terms like "society", "culture", "ritual", "New World / Old World",
    discusses canons, national literatures, etc.
- For passages about "national literature", "young vs old societies", "canons", etc.,
  the style is usually closer to cultural theory / ethnology than a newspaper editorial.

E. PARAGRAPH / SENTENCE ORDER (reordering, e.g., A–E)
-----------------------------------------------------
- Use clear logical markers:
  * Time: "By mid-December 1914" → should appear earlier than "By the end of the war".
  * Cause-effect: context first, result next.
  * Pronouns and definite descriptions must refer to something already introduced.
- Typical structure:
  1) Background or setting (often with dates or general context).
  2) Development of situation (problems, conflicts).
  3) Consequences or reactions.
  4) Final outcome or conclusion (e.g., repeal, solution, new law).
- Eliminate orders where:
  * A sentence refers to "this" or "such a situation" before it is introduced.
  * A conclusion appears before reasons.
  * A time sequence is reversed without explanation.

F. INFERENCE / ATTITUDE / PURPOSE
---------------------------------
- Focus on what the passage as a whole is doing:
  * explaining a conflict (e.g., between sugarcane and guinea grass),
  * describing bio-cultural history,
  * analyzing extinction events,
  * etc.
- For purpose:
  * "To explain the bio-cultural conflict between X and Y" is better than
    a narrow or alarmist option if the passage is broadly explanatory.
- For attitude:
  * Identify whether the tone is critical, nostalgic, analytical, etc.

G. AMBIGUOUS / PARTIAL OCR
---------------------------
- If some words are broken or letters are wrong (e.g., "21\" century"),
  infer the intended phrase from context ("21st century").
- If one or two options are slightly garbled but still recognizable,
  decode them logically and still choose the best.

==================================================
FINAL OUTPUT REMINDER
==================================================
- Scan all visible question numbers on this page.
- For each, decide the SINGLE best answer.
- Output ONLY lines in the exact format: "<number>: <choice>"
- Sort lines strictly by question number in ascending order.
- Do NOT include explanations or any extra text.
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
