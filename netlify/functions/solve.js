// netlify/functions/solve.js

// Netlify Node 18+ 에서는 global fetch 가 있지만,
// 만약 없을 경우를 대비해 node-fetch 로 폴백.
const fetchFn = (...args) => {
  if (typeof fetch !== "undefined") return fetch(...args);
  return import("node-fetch").then(({ default: f }) => f(...args));
};

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

const SYSTEM_PROMPT = `
You are an AI that answers Korean college transfer English multiple-choice exams.

[Primary goals, in order]
1) Minimize wrong answers.
2) Never skip a question that appears in the text.
3) Output only the final answer key in the required format.

[Input]
- OCR text of one or more exam pages.
- The text can contain: question numbers, directions, passages, choices (A/B/C/D/E or ①②③④).
- Some questions ask for the correct statement; some ask for the WRONG / NOT / EXCEPT statement; some ask which underlined word is NOT correct; some ask to reorder sentences, etc.

[Output format rules – MUST follow exactly]
- One question per line.
- Format: "<number>: <capital letter>" (examples: "7: D", "19: B").
- No explanations, no Korean, no extra text, no blank lines, no punctuation other than colon and space.
- Question numbers must be in ascending order if possible.
- Exactly one answer for each visible question number.

[General solving method – internal only]
- First, scan the whole OCR text and list all clearly visible question numbers.
- For each question:
  - Gather its stem, passage (if any), and its choices.
  - Then choose exactly one best option.

[Special rules by question type]

1) Normal comprehension / vocabulary / inference questions
- Use the passage meaning and logic to choose the option that is most strongly supported.
- When several options look possible, prefer the one that matches the key idea and tone of the passage.
- Do NOT guess based only on how “fancy” or “rare” a word looks.

2) Questions like “Which is NOT correct?”, “Which is INCORRECT?”, “Which is WRONG?”, “EXCEPT”
- Treat these as reverse questions.
- INTERNAL PROCEDURE:
  - For each choice A–E, decide if the statement is TRUE or FALSE with respect to the passage:
    - TRUE = clearly stated, strongly implied, or naturally supported by the passage.
    - FALSE = contradicts the passage OR there is no sufficient support in the passage.
  - Mark exactly ONE choice as FALSE. That FALSE choice is the correct answer.
- Very important:
  - If the passage directly supports or clearly implies a choice, you MUST treat that choice as TRUE, even if it sounds negative, critical, or surprising.
  - If a choice makes a stronger or exaggerated claim than the passage, treat it as FALSE.

3) “Which underlined word/phrase is NOT correct?” (word choice / usage questions)
- For each underlined expression:
  - Check its dictionary meaning and typical usage.
  - Check if it fits both the grammatical structure AND the logical meaning of the sentence and passage.
- Choose the ONLY underlined word that is wrong in meaning or usage.
- Pay special attention to:
  - Time/sequence words like “predate / postdate / precede / follow” and logical polarity (increase vs decrease, possible vs impossible).
  - Words that reverse meaning (e.g., “cause” vs “prevent”).
- Very important:
  - Do NOT treat a word as wrong just because it is rare or looks unusual.
  - Academic expressions such as “slippage between A and B”, “tension between A and B”, “microcosm of ~”, etc. can be correct if they match the context.
  - Prefer the option whose literal meaning clearly contradicts the facts described in the passage (for example, saying that digital procedures “postdate” computers when the passage explains they existed long before computers).

4) Reordering sentence questions
- Reconstruct a coherent paragraph that:
  - Introduces the topic naturally.
  - Respects time order and logic.
  - Has smooth pronoun and article references (“this city”, “such a practice”, “these hotels”, etc.).
- Choose the option whose order best matches this coherent structure.

5) Inference questions (“What can be inferred…?”)
- Choose only statements that are strongly supported by the passage.
- Do NOT choose options that add new claims that the passage does not support (even if they sound reasonable).

[If information seems partial]
- Still choose exactly ONE answer per question.
- Use the passage meaning and the strongest logical constraints (time order, cause/effect, contrast, definitions).
- Never output “I don’t know” or any explanation.

[Final reminder]
- Follow all output format rules strictly: only lines like “19: B”.
- Do not include any other text.
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
    const stopToken = process.env.STOP_TOKEN || "XURTH";
    const temperature = Number(process.env.TEMPERATURE ?? 0.1);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const ocrTextRaw = String(body.ocrText || body.text || "");
    const ocrText = ocrTextRaw.trim();

    if (!ocrText) {
      return json(400, { ok: false, error: "Missing ocrText" });
    }

    const userPrompt = [
      "You will receive OCR text from an English multiple-choice exam.",
      `Page: ${page}`,
      "",
      "OCR TEXT:",
      ocrText,
      "",
      `Remember: output only lines in the exact format "number: LETTER".`,
    ].join("\n");

    const res = await fetchFn("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site-solve-fn",
      },
      body: JSON.stringify({
        model,
        temperature,
        stop: [stopToken],
        messages: [
          { role: "system", content: SYSTEM_PROMPT.trim() },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return json(res.status, {
        ok: false,
        error: `OpenRouter HTTP ${res.status}`,
        details: text.slice(0, 500),
      });
    }

    const data = await res.json();
    const raw = String(data.choices?.[0]?.message?.content || "").trim();

    // STOP_TOKEN 이전까지만 사용
    const cleaned = raw.split(stopToken)[0].trim();

    const lines = cleaned
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const answers = {};
    const questionNumbers = [];
    const answerLines = [];

    for (const line of lines) {
      const m = line.match(/^(\d+)\s*[:\-]\s*([A-E])(\?)?\s*$/i);
      if (!m) continue;
      const qNum = Number(m[1]);
      const choice = m[2].toUpperCase();
      const unsure = !!m[3];

      answers[qNum] = choice;
      questionNumbers.push(qNum);
      answerLines.push(`${qNum}: ${choice}${unsure ? "?" : ""}`);
    }

    const outputLines = answerLines.length > 0 ? answerLines : lines;

    return json(200, {
      ok: true,
      text: outputLines.join("\n"),
      debug: {
        page,
        model,
        questionNumbers,
        answers,
        finishReason: data.choices?.[0]?.finish_reason ?? null,
        ocrTextPreview: ocrText.slice(0, 400),
      },
    });
  } catch (err) {
    console.error("solve.js error", err);
    return json(500, {
      ok: false,
      error: err && err.message ? err.message : "Unknown error in solve function",
    });
  }
};
