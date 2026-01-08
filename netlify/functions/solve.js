// netlify/functions/solve.js
// 편입영어 객관식 기출용 solve 함수 (OpenRouter + universal 프롬프트)

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

// 모든 학교/모든 연도 편입영어 객관식 기출 공용 SYSTEM 프롬프트
const SYSTEM_PROMPT = `
You are an expert grader for Korean university transfer exams
("편입 영어" 객관식). Your job is to read OCR text of the test paper
and output ONLY the correct options for each visible question.

Exam style:
- English multiple-choice questions (vocabulary, grammar, error spotting,
  sentence ordering, reading comprehension, etc.).
- Each question has exactly 4 options: 1–4 (or A–D).
- Numbers like 1., 2), 3] or "QUESTION 17" mark question numbers.

Your goals, in order:
1) Minimize wrong answers.
2) Do NOT miss any visible question number in the OCR text.
3) Keep the output extremely short and regular so it is easy to parse.

--------------------------------
HOW TO INTERPRET THE OCR TEXT
--------------------------------
- Ignore line breaks, page breaks, weird symbols, and OCR noise.
- Underlined words may appear in () or <> or with stray characters.
- If a passage header like [QUESTIONS 24–26] or "Questions 33-35" appears,
  all those question numbers share that passage.
- Only answer for question numbers whose stem and choices actually appear
  in the OCR text. Do NOT invent answers for unseen questions.

--------------------------------
DECISION RULES (VERY IMPORTANT)
--------------------------------
Use these rules INTERNALLY; do NOT explain them in the output.

1) Single-blank vocabulary / meaning questions
   - Choose the option that best matches BOTH:
     • the meaning required by the sentence AND
     • the most natural collocation and register.
   - Strongly PREFER standard collocations like "pose a dilemma",
     "insignificant amount of time", "boon to astronomers".
   - If an option is grammatically OK but sounds odd or rare,
     and another option is clearly a common expression, pick the common one.

2) Multi-blank questions (two or more blanks in one sentence or passage)
   - Evaluate each choice as a SET.
   - A choice is acceptable ONLY if **all** blanks are natural and coherent
     with the sentence and passage.
   - If even one blank in a choice is clearly wrong, REJECT that choice.
   - Prefer choices where:
     • meaning fits the context,
     • collocations are standard,
     • tone matches the passage (formal, academic, journalistic, etc.).

3) Error-identification questions (find the underlined error)
   - Pick the **most clearly wrong** or ungrammatical underlined part.
   - Do NOT choose a phrase that is merely a bit awkward but still
     grammatical and used in real English.
   - Prioritize obvious errors in:
     • verb tense/agreement,
     • word choice / idiom / collocation,
     • prepositions, articles, or basic syntax.
   - Example principle: "posted a dilemma" is incorrect; "in order to steer
     quotas" may be slightly awkward but can be acceptable → choose the
     clearly incorrect one.

4) Sentence ordering / paragraph ordering
   - Ensure the order gives a coherent paragraph:
     • introductions before details,
     • causes before results,
     • chronological or logical flow (past → later; general → specific).
   - Check for pronouns, discourse markers (however, therefore, then, etc.)
     and time expressions that constrain the order.

5) Author / tone / purpose questions
   - Judge the passage style: academic article, science paper, newspaper
     editorial, popular science for lay readers, exam instructions, etc.
   - Consider:
     • technical vs everyday vocabulary,
     • presence of citations/data,
     • intended audience (experts vs general public),
     • tone (neutral, persuasive, critical, ironic, etc.).
   - Choose the option that best matches both content AND level/audience.

6) Always answer
   - Even if the OCR is messy or the information is incomplete, you MUST
     pick the single BEST option among 1–4 for every visible question
     number.

--------------------------------
OUTPUT FORMAT (STRICT)
--------------------------------
- Output ONLY the final answers, nothing else.
- ONE line per question, in ascending order by question number.
- Format of each line must be:

  <question_number>: <option_letter>

  where <option_letter> is one of: A, B, C, D corresponding to 1–4.

- Examples of VALID output:
  1: A
  2: D
  3: B
  4: C

- Do NOT add explanations, reasoning, comments, headings,
  "UNSURE", percent signs, or any extra text.
- NEVER output options beyond A–D.
  • Do NOT output E, 5, or anything similar.
  • If none of the options seems perfect, still choose the LEAST WRONG
    among A–D.

Think carefully, follow the decision rules above, and then reply ONLY
with lines of the form "<number>: <A|B|C|D>".
`;

// "1: A" 같은 텍스트에서 번호와 보기를 파싱
function parseAnswersFromText(text) {
  const answers = {};
  const questionNumbers = [];
  const lines = String(text || "").split(/\r?\n/);

  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s*[:\-]\s*([A-Da-d1-4])/);
    if (!m) continue;

    const q = parseInt(m[1], 10);
    if (!Number.isFinite(q)) continue;

    let token = m[2].toUpperCase();
    let idx;

    if (/[A-D]/.test(token)) {
      idx = token.charCodeAt(0) - 64; // A→1, B→2 ...
    } else {
      idx = parseInt(token, 10);
      if (!(idx >= 1 && idx <= 4)) continue;
      token = String.fromCharCode(64 + idx);
    }

    if (!(q in answers)) {
      answers[q] = idx; // 1–4
      questionNumbers.push(q);
    }
  }

  questionNumbers.sort((a, b) => a - b);
  return { questionNumbers, answers };
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

    const model =
      process.env.MODEL_NAME || "anthropic/claude-3.7-sonnet";
    const maxTokens = Number(process.env.MAX_TOKENS || 256);
    const temperature = Number(process.env.TEMPERATURE ?? 0.1);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = Number(body.page || 1);
    const ocrTextRaw = body.ocrText || body.text || "";
    const ocrText = String(ocrTextRaw || "").trim();

    if (!ocrText) {
      return json(400, { ok: false, error: "Missing ocrText" });
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: ocrText },
    ];

    const reqBody = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    };

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
      body: JSON.stringify(reqBody),
    });

    if (!resp.ok) {
      let errBody;
      try {
        errBody = await resp.json();
      } catch {
        errBody = await resp.text();
      }
      const message =
        (errBody && errBody.error && errBody.error.message) ||
        (typeof errBody === "string" ? errBody : "OpenRouter error");
      return json(500, { ok: false, error: message, raw: errBody });
    }

    const data = await resp.json();
    const choice = data.choices && data.choices[0];
    const content =
      (choice && choice.message && choice.message.content) || "";

    if (!content.trim()) {
      return json(500, {
        ok: false,
        error: "Empty answer from model",
        dataPreview: JSON.stringify(data).slice(0, 400),
      });
    }

    const { questionNumbers, answers } = parseAnswersFromText(content);

    if (!questionNumbers.length) {
      return json(500, {
        ok: false,
        error: "No answers parsed from model output",
        raw: content,
        dataPreview: JSON.stringify(data).slice(0, 400),
      });
    }

    // 정규화된 "번호: 보기" 텍스트로 다시 구성
    const lines = questionNumbers.map((q) => {
      const idx = answers[q]; // 1–4
      const letter = String.fromCharCode(64 + idx); // 1→A
      return `${q}: ${letter}`;
    });
    const finalText = lines.join("\n");

    const finishReason =
      choice.finish_reason || choice.native_finish_reason || null;

    return json(200, {
      ok: true,
      text: finalText,
      debug: {
        page,
        model: data.model || model,
        questionNumbers,
        answers,
        finishReason,
        ocrTextPreview: ocrText.slice(0, 400),
      },
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: err && err.message ? err.message : "Unknown error",
      stack: err && err.stack ? String(err.stack).split("\n").slice(0, 3).join("\n") : undefined,
    });
  }
};




