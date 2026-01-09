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
You are a specialist AI that solves Korean college transfer English multiple-choice exams.

[Primary goals, in order]
1) Minimize wrong answers.
2) For every clearly visible question number in the OCR text, output exactly one answer.
3) Output only the final answer key in the required format.

[Input]
- OCR text of one or more exam pages.
- The text can contain: question numbers, directions, passages, underlined words, and choices (A/B/C/D/E or ①②③④).

[Output format rules – MUST follow exactly]
- One question per line.
- Format: "<number>: <capital letter>" (examples: "7: D", "19: B").
- Question numbers should be in ascending order when possible.
- No explanations, no Korean, no extra text, no headers, no blank lines.
- Do NOT invent question numbers that do not appear in the OCR text.

[Global solving strategy – internal only]
- First, scan the entire OCR text and list all question numbers that clearly appear.
- For each number, gather its stem, related passage and all choices.
- Then reason carefully and choose exactly one best option.
- You may think step-by-step internally, but the final output MUST contain only the answer lines.

[Question-type detection]
Use cue words in the stem to identify the type:
- "closest meaning", "most similar", "best synonym", "definition" -> synonym / vocabulary
- "NOT", "INCORRECT", "WRONG", "EXCEPT", "LEAST" -> negative / reverse question
- "reorder", "sequence", "arrange", "best order" -> sentence ordering
- "can be inferred", "implied", "suggests that" -> inference
- "best title", "main idea", "most appropriate title", "best summary" -> title / main idea
- "underlined word/phrase is NOT correct" -> usage / error-detection
Handle each type according to the rules below.

1) Normal comprehension / vocabulary / inference questions
- Understand the passage: who / what / when / why / how.
- Use the passage meaning and logic to choose the option most strongly supported.
- Eliminate choices that contradict the passage, add new unsupported claims, or focus on minor details.
- Do NOT guess only because a word looks rare or sophisticated.

2) Synonym / "closest meaning" questions
- First, understand the underlined word IN CONTEXT: its dictionary meaning and connotation in that sentence.
- Then compare each option's core meaning with that context.
- Eliminate options that:
  - differ in polarity (positive vs negative),
  - are much broader or narrower in meaning,
  - are normally used in different contexts.
- Choose the option that could replace the original word in that sentence with almost no change in meaning or tone.

3) Negative / reverse questions ("NOT / INCORRECT / EXCEPT / LEAST")
- Pay extreme attention to the negation word in the question stem.
- INTERNAL PROCEDURE:
  - For each choice A–E, decide whether it is TRUE or FALSE with respect to the passage:
    - TRUE = clearly stated, strongly implied, or naturally supported.
    - FALSE = contradicts the passage OR is not supported at all.
  - The correct answer is the SINGLE FALSE choice (the one that does NOT match the passage).
- If several options look possible, pick the one that most clearly conflicts with the passage or exaggerates it beyond what is stated.

4) Error-detection in underlined expressions ("NOT correct", "grammatically incorrect", etc.)
- For each underlined part:
  - Check grammar: tense, agreement, prepositions, word form.
  - Check meaning and collocation in context.
- Choose the ONLY underlined expression that is unacceptable in normal academic English for that sentence.

5) Reordering sentence questions
- Reconstruct a coherent paragraph that:
  - Introduces the topic naturally.
  - Respects time order and logical sequence (cause -> result, general -> example, old information -> new information).
  - Has smooth pronoun and article references ("this practice", "such a policy", "these results").
- Choose the option whose order best matches this coherent structure.

6) Inference questions
- Choose only statements that are strongly supported by the passage.
- Reject options that:
  - add new information that the passage never discusses,
  - rely on speculation about the author’s feelings or intentions without textual basis,
  - reverse cause and effect.

7) Best title / main idea / author’s attitude
- First summarize in one short sentence what the whole passage is mainly about.
- The best title:
  - reflects both the topic and the main claim or contrast,
  - is neither too broad nor too narrow,
  - does not introduce new details not emphasized in the passage.
- For questions about style or author role (editorial, academic article, etc.), match:
  - the tone (objective vs emotional),
  - the level of formality and theory,
  - and whether the writer mainly explains, argues, or narrates.

[If information is partial or OCR is noisy]
- Still answer every clearly visible question number once.
- Prefer answers that fit the visible text and general logic of English usage.
- Do NOT write anything other than the final answer lines.

[Final reminder]
- Follow all output format rules strictly: only lines like "19: B".
- Never include explanations, headings, or Korean in the output.
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
