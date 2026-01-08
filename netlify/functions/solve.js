// netlify/functions/solve.js
// -------------------------
// 역할: 편입 영어 객관식 기출 "정답만" 생성하는 함수
// 입력: { ocrText: string, page?: number }
// 출력: { ok: true, text: "1: A\n2: D\n...", debug: {...} } 또는 { ok: false, error: "..." }
//
// 필요한 환경변수 (Netlify 에서 설정):
// - OPENROUTER_API_KEY  (필수)
// - MODEL_NAME          (선택, 예: "anthropic/claude-sonnet-4.5", 기본값: "openai/gpt-4.1")
// - TEMPERATURE         (선택, 기본 0.1)

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  try {
    // 1) POST 만 허용
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    // 2) API Key 확인
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, { ok: false, error: "OPENROUTER_API_KEY is not set" });
    }

    // 3) 환경변수 (모델, 온도)
    const model = process.env.MODEL_NAME || "openai/gpt-4.1";
    const temperature = Number(process.env.TEMPERATURE ?? 0.1);

    // 4) body 파싱
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? null;
    const ocrText = String(body.ocrText || body.text || "").trim();

    if (!ocrText) {
      return json(400, { ok: false, error: "Missing ocrText" });
    }

    // 5) 편입 기출 전용 프롬프트 (전체 기출 공용)
    const TASK_PROMPT = `
You are an expert grader for Korean university transfer English exams ("편입 영어"), covering all schools and all years.
You see OCR text from one printed test page (multiple-choice only).

Your job:
- Read ALL visible questions on this page.
- For EVERY visible question number, choose EXACTLY ONE answer choice (A, B, C, D, or E).
- Some questions may only have 4 choices (A–D). If there is no E, never invent E.
- Always output answers for ALL visible question numbers on this page. No missing numbers.

Answer format (very important):
- Final output must contain ONLY lines like:
  1: A
  2: D
  3: B
- One question per line.
- Use the question number as a plain integer, then colon, then a single capital letter A–E.
- No extra text, no explanations, no comments, no "UNSURE", no blank lines.

General rules (for ALL question types):
- Carefully match each answer to the correct question number shown in the OCR text.
- If OCR is slightly noisy (typos, broken words), try to infer the original sentence.
- NEVER use outside real-world knowledge to override the passage logic. Follow the passage itself.
- If two options both look plausible, choose the one that best fits the exact wording and logic of the question.

Specific rules by type:

1) Vocabulary / closest meaning / synonym questions:
- Focus on the underlined word and sentence context.
- Pick the option whose meaning fits BOTH the dictionary sense AND the tone of the sentence.
- Avoid options that are too general, too weak, or the wrong connotation.

2) Error-identification / "must be corrected" questions:
- Typically: one sentence with four underlined parts (A, B, C, D).
- Assume EXACTLY ONE underlined part is wrong, unless the test clearly says otherwise.
- Treat CLEAR collocation/word-choice errors (e.g., wrong verb + object like "posted a dilemma" instead of "posed a dilemma") as strong errors,
  even if grammar is otherwise okay.
- Do NOT choose parts that are only slightly awkward in style if they are grammatically and collocationally acceptable.
- When in doubt, prefer the part that is clearly wrong in standard written English.

3) Reading / inference / EXCEPT / NOT TRUE / LEAST / UNABLE TO BE INFERRED:
- Identify whether the question asks for:
  - something supported (TRUE / BEST summary / MAIN idea),
  - or something NOT supported (EXCEPT / NOT true / LEAST / UNABLE to be inferred).
- For "NOT true" / "LEAST" / "UNABLE to be inferred" types:
  - Check each option against the passage ONLY.
  - Reject options that add new information or overgeneralize beyond what the passage says,
    even if they sound plausible in the real world.
  - Choose the option that is least supported, not mentioned, or contradicted by the passage.
- For "TRUE"/"BEST" types:
  - Choose the option that is MOST directly supported and accurately reflects the passage’s nuance,
    not the one that introduces extra assumptions.

4) Sentence-order / paragraph reordering questions:
- When reordering sentences (A, B, C, D etc.), think in terms of:
  - topic introduction,
  - time/space sequence,
  - cause → effect,
  - general → specific,
  - problem → solution.
- Prefer the order that gives the smoothest logical flow and natural pronoun/reference links.

5) Sentence-insertion / position-of-sentence questions:
- You must choose the position where the given sentence works best as a BRIDGE:
  - It should follow naturally from the previous sentence,
  - AND prepare or support the next sentence.
- Do NOT rely only on simple word overlap (e.g., "navel", "shame", "gods").
  Instead, think about the rhetorical role:
  - Is it giving an example, an explanation of a symbol, a contrast, a result, or a generalization?
- Place it where that role is needed in the paragraph’s logical progression.

6) Discourse markers / connectors (however, therefore, in consequence, instead of, etc.):
- Always check:
  - Does this connector match the relationship between the two sentences (cause–effect, contrast, sequence)?
- Do not choose a strong contrast or emotional word ("however", "tired of", "recklessly") if the logic is simple cause–effect or explanation.
- Prefer connectors that match the actual logical relation, even if another option feels more dramatic.

Output requirements (repeat):
- Output ONLY lines of "number: LETTER" (A–E).
- Do NOT output any explanation, reasoning, or comments.
- Do NOT output any other words before, between, or after the answers.
`;

    const userContent = `${TASK_PROMPT}

[OCR TEXT START]
${ocrText}
[OCR TEXT END]
`;

    // 6) OpenRouter API 호출
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app/",
        "X-Title": "answer-site-solve",
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: 512,
        messages: [
          {
            role: "system",
            content: "You are a precise multiple-choice exam solver. Follow the user's format instructions exactly and never output explanations.",
          },
          {
            role: "user",
            content: userContent,
          },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return json(502, { ok: false, error: "OpenRouter HTTP error", status: response.status, body: text });
    }

    const data = await response.json();

    const choice = data.choices && data.choices[0];
    const content = choice && choice.message && typeof choice.message.content === "string"
      ? choice.message.content.trim()
      : "";

    if (!content) {
      return json(500, {
        ok: false,
        error: "Empty answer from model",
        dataPreview: JSON.stringify(data).slice(0, 400),
      });
    }

    // 7) 결과 파싱해서 디버그용 구조 만들기
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

    const answersMap = {};
    for (const line of lines) {
      // 허용 형식 예: "1: A" 또는 "1 - A" 또는 "1 A"
      const m = line.match(/^(\d+)\s*[:\-]?\s*([A-E1-5])$/i);
      if (!m) continue;
      const qNum = Number(m[1]);
      let ansRaw = m[2].toUpperCase();

      // 혹시 숫자(1~5)로 주면 A~E로 변환
      if (/[1-5]/.test(ansRaw)) {
        const idx = Number(ansRaw) - 1;
        const letters = ["A", "B", "C", "D", "E"];
        ansRaw = letters[idx] || ansRaw;
      }

      answersMap[qNum] = ansRaw;
    }

    const questionNumbers = Object.keys(answersMap)
      .map((n) => Number(n))
      .sort((a, b) => a - b);

    return json(200, {
      ok: true,
      text: content,
      debug: {
        page,
        model,
        questionNumbers,
        answers: answersMap,
        finishReason: choice.finish_reason || choice.native_finish_reason || "unknown",
        ocrTextPreview: ocrText.slice(0, 300),
      },
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "Unexpected error in solve",
      detail: String(err && err.message ? err.message : err),
    });
  }
};
