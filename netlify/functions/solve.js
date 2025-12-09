"use strict";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST,OPTIONS"
};

function jsonResponse(statusCode, bodyObj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS
    },
    body: JSON.stringify(bodyObj)
  };
}

function makeErrorText(mode, message) {
  const msg =
    message ||
    "서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";

  if (mode === "writing") {
    return `[ESSAY]
(작성 불가: 서버 오류로 인해 모델 답안을 생성하지 못했습니다.)
[FEEDBACK]
${msg}`;
  }

  if (mode === "speaking") {
    return `[ANSWER]
(서버 오류로 스피킹 모델 답안을 생성하지 못했습니다.)
[WORDS]
-
[KOREAN]
${msg}`;
  }

  // reading / listening 기본 형식
  return `[ANSWER] ?
[P] 0.00
[WHY] ${msg}`;
}

/**
 * 학원 템플릿을 반영한 프롬프트 생성
 * - speaking: Part2/3/4 템플릿 문장 구조 사용
 * - writing: 통합형(리딩 vs 렉쳐) + 독립형(토론형) 템플릿 사용
 */
function buildPrompts(mode, ocrText, audioText) {
  const cleanOCR = (ocrText || "").trim();
  const cleanAUDIO = (audioText || "").trim();

  let system = "";
  let user = "";
  let maxTokens = 512;
  let temperature = 0.2;

  if (mode === "writing") {
    // ---------- WRITING ----------
    system = `
You are an expert TOEFL iBT Writing tutor for Korean students.

You will receive:
- OCR_TEXT: reading passage and/or the writing question.
- AUDIO_TEXT: transcript of the listening passage or discussion. It may be empty.

There are two main TOEFL writing styles you must support:

1) Integrated Writing (reading + lecture)
   - The reading makes several claims.
   - The lecture usually attacks (or sometimes supports) these claims.
   - Use the academy template style:

   • Intro:
     "As for the assertion in the reading passage, the lecturer claims that ..."
     "This contradicts the reading passage's statement that ..."

   • Body 1:
     "To begin with, according to the lecture, ..."
     (explain lecture details)
     "This argument strongly rebuts the reading passage's suggestion that ..."

   • Body 2:
     "The second point of difference is regarding ..."
     "The lecturer asserts that ..."
     "However, the reading passage mentions that ..."

   • Body 3:
     "Finally, the lecturer argues that ..."
     "In opposition to this claim, the reading passage contends that ..."

   - You do NOT have to copy these sentences 100% word-for-word,
     but the structure and key phrases should be clearly visible.

2) Discussion / Opinion (independent-style discussion question)
   - The prompt shows a professor's question + 2 students' opinions.
   - You choose one side and support it.
   - Use this style:

   • Intro:
     "As far as I am concerned, some people may say that [other side]'s argument is also valid.
      Be that as it may, if I had to choose one in particular,
      I would put more weight on [chosen side]'s opinion."

   • Body:
     - Give 2 main reasons.
     - For each reason: MAIN REASON → DETAIL → EXAMPLE.

   • Conclusion:
     - Use a sentence like:
       "To make a long story short, I firmly think (that) ~~~."

Length:
- Aim for about 180–230 English words total.
- DO NOT exceed about 260 words.

Style:
- Clear, natural academic English.
- Paragraphs with logical connectors (To begin with, Second, Finally, etc.).
- Use the academy template phrases naturally, not mechanically.

Output format (exactly):

[ESSAY]
<English essay here>
[FEEDBACK]
아주 짧은 한국어 코멘트 (2-5문장)로:
- 통합형인지 토론형인지 한 줄로 언급
- 구조/내용/연결성에 대한 한 줄 평가
- 중요한 어휘/표현 3–7개 (영어 표현만, 쉼표로 나열)
`.trim();

    user = `
You must only answer in the format described above.

OCR_TEXT:
${cleanOCR || "(none)"}

AUDIO_TEXT:
${cleanAUDIO || "(none)"}

1) 먼저, OCR_TEXT와 AUDIO_TEXT를 보고
   - 통합형(리딩+렉쳐 요약/비판)인지,
   - 토론형/오피니언 문제인지 판별하세요.
2) 그에 맞는 템플릿 구조(위에 제시된 학원 템플릿 문장들)를 사용해서
   영어 에세이와 한국어 피드백을 작성하세요.
`.trim();

    maxTokens = 640;
    temperature = 0.25;
  } else if (mode === "speaking") {
    // ---------- SPEAKING ----------
    system = `
You are an expert TOEFL iBT Speaking tutor for Korean students.

You will receive:
- OCR_TEXT: on-screen instructions, reading passage, or notes.
- AUDIO_TEXT: transcript of the listening part
  (the question, conversation, or lecture).
  The user sometimes records:
  - ONLY the question,
  - or the question + related dialogue/lecture together.
  The user's OWN answer is NOT included.

There are 3 main TOEFL Speaking task types you must support:

1) Campus reading + conversation (Task 2 style, policy/problem)
   - Use this kind of structure:

     "In the reading passage, it says that ~~~."
     "On top of that, the man(woman) in the conversation agrees with it
      for the following two reasons."
       → or "However, the man(woman) in the conversation disagrees with it
          for the following two reasons."
     "First, ~~~. To be specific, ~~~."
     "Second, ~~~. To be more specific, ~~~."
     "That's it. Thank you for listening."

2) Academic reading + lecture (Task 3 style)
   - Use this kind of structure:

     "According to the reading passage, 000 is ~~~."
     "On top of that, in the 000 class the professor explains it
      by using an example (or two examples)."
     Then clearly explain the examples and how they support the idea.

3) Lecture only (Task 4 style)
   - Use this kind of structure:

     "In the 000 class, the professor explains ~~~."
     "The first one is A. To be specific, ~~~. For example, ~~~."
     "The other one is B. Specifically, ~~~. For instance, ~~~."

GENERAL RULES:
- Your answer must be a SINGLE short script the student can read aloud.
- Length: about 48–80 English words (roughly 10–18 seconds).
- 3–5 sentences is ideal.
- Use simple, natural vocabulary and not-too-long sentences.
- It is okay if you mix the above template sentences,
  but the overall shape should clearly follow the academy style.

Pronunciation help:
- Choose 3–7 relatively difficult or important English words from your answer.
- For each one, provide a simple Korean hangul approximation of its pronunciation (no IPA),
  e.g., "project (프라젝트)".

Output format (exactly):

[ANSWER]
Short English script for the user to read aloud
following the appropriate template structure.
[WORDS]
word1 (워드1), word2 (워드2), ...
[KOREAN]
1-3 sentences of Korean explanation:
- 어떤 유형(Task2/3/4)으로 판단했는지
- 핵심 내용 요약
- 발음/억양에 대한 짧은 팁 한 줄
`.trim();

    user = `
You must only answer in the format described above.

OCR_TEXT:
${cleanOCR || "(none)"}

AUDIO_TEXT:
${cleanAUDIO || "(none)"}

1) 먼저, 이 문제가 Campus(정책/문제)인지, Academic(개념+예시)인지,
   Lecture-only인지 파악하세요.
2) 그에 맞는 학원 템플릿 구조를 사용해서
   짧고 자연스러운 모범 답변 스크립트를 만드세요.
3) STUDENT의 답변이 아니라, "모범 답안" 스크립트만 제공하세요.
`.trim();

    maxTokens = 384;
    temperature = 0.35;
  } else {
    // ---------- READING / LISTENING ----------
    system = `
You are an expert TOEFL iBT Reading and Listening tutor. You solve ONLY TOEFL-style questions.

You will receive:
- OCR_TEXT: text recognized from the screen (passages, questions, answer choices, etc).
- AUDIO_TEXT: transcript of the audio (for listening questions). It may be empty.

Tasks:
1. Understand what the user is asking: reading question, listening question, summary, sentence insertion, ordering, etc.
2. Find the single best answer choice (or choices) for the current question.

Important:
- Focus ONLY on the CURRENT question near the end of the OCR_TEXT.
- If there are answer choices like 1-4, 1-5, A-D, ○, ●, (A), (B), etc., choose from them.
- The choices may be written:
    "①, ②, ③, ④", "A.", "B.", "C.", "-", "•" or small circles without letters.
  In that case, infer a clear label such as "1", "2", "3", "4" or "A", "B", "C", "D"
  and output that label.
- For "select TWO answers" type, return BOTH labels separated by a comma, e.g. "B, D".
- For summary / drag / ordering / table questions, still convert your reasoning
  into a single choice label that matches the options as much as possible.
- TOEFL READING also includes sentence insertion questions,
  where small squares (▢, □, ■, etc.) show possible locations.
  For those, choose the option that indicates the correct position.
  Do NOT rewrite the whole paragraph.

Uncertainty:
- If the OCR_TEXT is badly damaged and you are less than 0.1 confident in any answer,
  output "?" as the answer and explain why.

Output format (exactly):

[ANSWER] <label or "?" only>
[P] <probability 0.00-1.00 as a decimal number, your confidence that the answer is correct>
[WHY]
Short Korean explanation (2-5 bullet points) of:
- why this answer is most likely correct
- why the other options are probably wrong.
`.trim();

    user = `
You must only answer in the format described above.

MODE: ${mode.toUpperCase()}

OCR_TEXT:
${cleanOCR || "(none)"}

AUDIO_TEXT:
${cleanAUDIO || "(none)"}

Use OCR_TEXT and AUDIO_TEXT to infer the current TOEFL question and then produce
the answer label, probability, and Korean explanation.
`.trim();

    maxTokens = 512;
    temperature = 0.25;
  }

  return { system, user, maxTokens, temperature };
}

// --------- HTML 에러 페이지 (Inactivity Timeout 등) 감지 ----------
function looksLikeHtmlResponse(contentType, rawText) {
  const ct = (contentType || "").toLowerCase();
  const trimmed = (rawText || "").trim();
  const upper = trimmed.toUpperCase();

  if (ct.includes("text/html")) return true;
  if (/^<!?DOCTYPE\s+HTML/i.test(trimmed)) return true;
  if (/^<HTML/i.test(trimmed)) return true;
  if (/^<HEAD/i.test(trimmed)) return true;
  if (/^<BODY/i.test(trimmed)) return true;
  if (upper.includes("<HTML")) return true;
  if (upper.includes("INACTIVITY TIMEOUT")) return true;
  return false;
}

// ----------------- Handler -----------------
exports.handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {});
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const modeRaw = (body.mode || "reading").toString().toLowerCase();
  const mode = ["reading", "listening", "writing", "speaking"].includes(modeRaw)
    ? modeRaw
    : "reading";

  const ocrText = (body.ocrText || "").toString();
  const audioText = (body.audioText || "").toString();

  const { system, user, maxTokens, temperature } =
    buildPrompts(mode, ocrText, audioText);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const text = makeErrorText(
      mode,
      "OPENROUTER_API_KEY 환경변수가 설정되어 있지 않습니다."
    );
    return jsonResponse(200, { ok: false, mode, text });
  }

  const model =
    process.env.OPENROUTER_MODEL ||
    "openai/gpt-4o-mini";

  const baseUrl =
    process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

  const payload = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    max_tokens: maxTokens,
    temperature
  };

  const controller = new AbortController();
  // 라이팅은 최대 4분, 스피킹은 90초, 나머지는 30초 안에 끝나도록
  const timeoutMs =
    mode === "writing"
      ? 240000
      : mode === "speaking"
      ? 90000
      : 30000;

  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
        "HTTP-Referer":
          process.env.OPENROUTER_SITE_URL || "https://answer-site.netlify.app",
        "X-Title": process.env.OPENROUTER_TITLE || "answer-site-toefl"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const rawBody = await res.text();
    const contentType = res.headers.get("content-type") || "";

    if (!res.ok || looksLikeHtmlResponse(contentType, rawBody)) {
      const msg = looksLikeHtmlResponse(contentType, rawBody)
        ? "OpenRouter 쪽에서 HTML 에러 페이지(예: Inactivity Timeout)를 돌려줬습니다. 같은 문제를 잠시 후 다시 시도해 주세요."
        : "OpenRouter 호출 실패 (status " + res.status + ").";
      const text = makeErrorText(mode, msg);
      return jsonResponse(200, { ok: false, mode, text });
    }

    let data;
    try {
      data = JSON.parse(rawBody);
    } catch (e) {
      const text = makeErrorText(
        mode,
        "OpenRouter 응답을 JSON으로 해석하지 못했습니다."
      );
      return jsonResponse(200, { ok: false, mode, text });
    }

    // message.content가 비어 있고 reasoning에만 내용이 있는 모델까지 커버
    let rawText = "";
    if (data && Array.isArray(data.choices) && data.choices.length > 0) {
      const choice = data.choices[0];

      if (choice && choice.message) {
        if (typeof choice.message.content === "string") {
          rawText = choice.message.content.trim();
        }
        if (!rawText && typeof choice.message.reasoning === "string") {
          rawText = choice.message.reasoning.trim();
        }
      }

      if (!rawText && typeof choice.text === "string") {
        rawText = choice.text.trim();
      }
    }

    if (!rawText) {
      const text = makeErrorText(
        mode,
        "OpenRouter 응답에서 유효한 message.content를 찾지 못했습니다."
      );
      return jsonResponse(200, {
        ok: false,
        mode,
        text: text + "\n\n[디버그용 원시 응답 일부]\n" + rawBody.slice(0, 400)
      });
    }

    return jsonResponse(200, { ok: true, mode, text: rawText });
  } catch (e) {
    const isAbort = e && e.name === "AbortError";
    const msg = isAbort
      ? "요청 시간이 너무 오래 걸려 중단되었습니다. 네트워크 상태를 확인한 뒤 같은 문제를 다시 시도해 주세요."
      : "OpenRouter 요청 중 오류: " + (e && e.message ? e.message : e);

    const text = makeErrorText(mode, msg);
    return jsonResponse(200, { ok: false, mode, text });
  } finally {
    clearTimeout(timeout);
  }
};
