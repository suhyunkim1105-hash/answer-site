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
    message || "서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";

  if (mode === "writing") {
    return `[ESSAY]
(작성 불가: 모델 답안을 생성하지 못했습니다.)
[FEEDBACK]
${msg}`;
  }

  if (mode === "speaking") {
    return `[ANSWER]
(스피킹 답안을 생성하지 못했습니다.)
[WORDS]
-
[KOREAN]
${msg}`;
  }

  // reading / listening 공통
  return `[ANSWER] ?
[P] 0.00
[WHY]
${msg}`;
}

/**
 * message(또는 delta) 객체에서 content를 최대한 뽑아내는 헬퍼
 * - OpenAI/OpenRouter 기본: string
 * - Anthropic 스타일: [{type:"text", text:"..."}, ...]
 * - 그 외 변형들까지 최대한 방어적으로 처리
 */
function extractContentFromMessage(msg) {
  if (!msg) return "";

  const c = msg.content;

  // 1) content가 문자열
  if (typeof c === "string") {
    return c;
  }

  // 2) content가 배열 (파트 여러 개)
  if (Array.isArray(c)) {
    const parts = [];
    for (const part of c) {
      if (!part) continue;

      if (typeof part === "string") {
        parts.push(part);
        continue;
      }

      if (typeof part === "object") {
        // Anthropic-style: { type: "text", text: "..." }
        if (part.type === "text" && typeof part.text === "string") {
          parts.push(part.text);
          continue;
        }
        // { text: "..." }
        if (typeof part.text === "string") {
          parts.push(part.text);
          continue;
        }
        // { text: { value: "..." } }
        if (part.text && typeof part.text.value === "string") {
          parts.push(part.text.value);
          continue;
        }
        // { value: "..." }
        if (typeof part.value === "string") {
          parts.push(part.value);
          continue;
        }
      }
    }
    return parts.join("\n").trim();
  }

  // 3) content가 객체인 경우
  if (typeof c === "object" && c !== null) {
    if (typeof c.text === "string") {
      return c.text;
    }
    if (c.text && typeof c.text.value === "string") {
      return c.text.value;
    }
    if (typeof c.value === "string") {
      return c.value;
    }
  }

  return "";
}

function buildPrompts(mode, ocrText, audioText) {
  const cleanOCR = (ocrText || "").trim();
  const cleanAUDIO = (audioText || "").trim();

  let system = "";
  let user = "";
  let maxTokens = 512;
  let temperature = 0.2;

  if (mode === "writing") {
    system = `
You are an expert TOEFL iBT Writing tutor.

You will receive:
- OCR_TEXT: the reading passage and/or the writing question.
- AUDIO_TEXT: the transcript of the listening passage for an integrated task. It may be empty.

Task:
- Infer the TOEFL writing task (integrated or independent / academic discussion).
- Write a high-scoring model answer that directly answers the question.

Length:
- Aim for about 150-225 English words total.
- Do NOT exceed about 250 words.

Style:
- Clear, natural academic English suitable for TOEFL.
- Well organized with an introduction, 1-2 body paragraphs, and a brief conclusion.
- For academic discussion tasks, sound like a student giving a thoughtful but concise contribution.

Output format (exactly):

[ESSAY]
<English essay here>
[FEEDBACK]
Very short Korean comments (2-4 sentences) summarizing:
- 구조, 내용, 연결성에 대한 한 줄 평가
- 중요한 어휘/표현 3-7개 (영어 표현만, 쉼표로 나열)
`.trim();

    user = `
You must only answer in the format described above.

OCR_TEXT:
${cleanOCR || "(none)"}

AUDIO_TEXT:
${cleanAUDIO || "(none)"}

Use OCR_TEXT and AUDIO_TEXT to infer the exact TOEFL writing prompt, then write the model essay and feedback.
`.trim();

    maxTokens = 640;
  } else if (mode === "speaking") {
    system = `
You are an expert TOEFL iBT Speaking tutor.

You will receive:
- OCR_TEXT: the on-screen instructions and any reading part.
- AUDIO_TEXT: the transcript of the listening part (the question or conversation). It may contain only the question; the user is NOT giving their own answer.

Task:
- Based on OCR_TEXT and AUDIO_TEXT, generate a single high-quality model spoken answer that the user can read aloud.
- The user has very little time, so the answer must be SHORT and easy to pronounce.

Length:
- About 40-70 English words (roughly 10-15 seconds of speech).
- 2-4 sentences maximum.
- Do NOT exceed about 90 words.

Pronunciation help:
- Choose 3-7 relatively difficult or important English words from your answer.
- For each one, provide a simple Korean hangul approximation of its pronunciation (no IPA), like "project (프라젝트)".

Output format (exactly):

[ANSWER]
Short English script for the user to read aloud.
[WORDS]
word1 (워드1), word2 (워드2), ...
[KOREAN]
1-2 sentences of Korean explanation: 핵심 내용 요약 + 발음이나 억양에 대한 짧은 팁.
`.trim();

    user = `
You must only answer in the format described above.

OCR_TEXT:
${cleanOCR || "(none)"}

AUDIO_TEXT:
${cleanAUDIO || "(none)"}

Use OCR_TEXT and AUDIO_TEXT to infer the TOEFL Speaking task and then produce the model spoken answer, pronunciation help, and Korean tips.
`.trim();

    maxTokens = 384;
  } else {
    // reading / listening 공통
    system = `
You are an expert TOEFL iBT Reading and Listening tutor. You solve ONLY TOEFL-style questions.

You will receive:
- OCR_TEXT: text recognized from the screen (passages, questions, answer choices, etc).
- AUDIO_TEXT: transcript of the audio (for listening questions). It may be empty.

Tasks:
1. Understand what the user is asking: reading question, listening question, summary, sentence insertion, etc.
2. Find the single best answer choice (or choices) for the current question.

Important:
- Focus ONLY on the CURRENT question near the end of the OCR_TEXT.
- If there are answer choices like 1-4, 1-5, A-D, etc, choose from them.
- If the options do NOT show labels (only empty circles ●/○, bullets, dashes, or just sentences in a list), infer implicit labels such as "1, 2, 3, 4" from top to bottom and answer using that label.
- For "Select TWO answers" type, return BOTH labels separated by a comma, e.g. "B, D" or "2, 4".
- For ordering / sequence questions (e.g., "put the events in the correct order"), compress your final answer into a short sequence like "3-1-4-2" or "B-D-A-C".
- For summary / drag / table questions, still convert your reasoning into a single choice label or a short sequence that clearly matches the options.
- TOEFL READING also includes sentence insertion questions, where small squares (▢, □, ■, etc.) show possible locations. For those, choose the option that indicates the correct position. Do NOT rewrite the whole paragraph.

Uncertainty:
- If the OCR_TEXT is badly damaged and you are less than 0.1 confident in any answer, output "?" as the answer and explain why.

Output format (exactly):

[ANSWER] <label, sequence, or "?" only>
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

Use OCR_TEXT and AUDIO_TEXT to infer the current TOEFL question and then produce the answer, probability, and Korean explanation.
`.trim();

    maxTokens = 512;
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

  const { system, user, maxTokens, temperature } = buildPrompts(
    mode,
    ocrText,
    audioText
  );

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const text = makeErrorText(
      mode,
      "OPENROUTER_API_KEY 환경변수가 설정되어 있지 않습니다."
    );
    return jsonResponse(200, { ok: false, mode, text });
  }

  const model =
    process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

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
  const timeoutMs = mode === "speaking" ? 20000 : 25000;
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

    // HTTP 레벨 에러 or HTML 에러 페이지
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

    // OpenRouter 스타일 에러 객체 처리 (choices가 없거나 error 필드가 있을 때)
    if (!data || typeof data !== "object") {
      const text = makeErrorText(
        mode,
        "OpenRouter 응답 형식이 예상과 다릅니다."
      );
      return jsonResponse(200, { ok: false, mode, text });
    }

    if (data.error) {
      const errMsg =
        (typeof data.error === "string"
          ? data.error
          : data.error.message || JSON.stringify(data.error).slice(0, 400)) ||
        "OpenRouter 응답에서 error가 반환되었습니다.";
      const text = makeErrorText(mode, "OpenRouter 오류: " + errMsg);
      return jsonResponse(200, { ok: false, mode, text });
    }

    const choices = Array.isArray(data.choices) ? data.choices : [];
    if (choices.length === 0) {
      const text = makeErrorText(
        mode,
        "OpenRouter 응답에 choices가 없습니다. 응답 일부: " +
          JSON.stringify(data).slice(0, 400)
      );
      return jsonResponse(200, { ok: false, mode, text });
    }

    const choice = choices[0];
    let rawText = "";

    // 1) message 기반 (비스트리밍)
    if (choice.message) {
      rawText = extractContentFromMessage(choice.message);
    }

    // 2) delta 기반 (스트리밍 조각이지만 비스트리밍에서도 있을 수 있음)
    if (!rawText && choice.delta) {
      rawText = extractContentFromMessage(choice.delta);
    }

    // 3) text 필드 (일부 모델)
    if (!rawText && typeof choice.text === "string") {
      rawText = choice.text;
    }

    // 4) content 필드만 문자열인 경우
    if (!rawText && typeof choice.content === "string") {
      rawText = choice.content;
    }

    // 5) 그래도 아무것도 없으면 진짜 포맷 문제 → 에러 메시지로 되돌림
    if (!rawText || !rawText.toString().trim()) {
      const text = makeErrorText(
        mode,
        "OpenRouter 응답에서 완성된 텍스트를 찾지 못했습니다. 응답 일부: " +
          JSON.stringify(choice).slice(0, 400)
      );
      return jsonResponse(200, { ok: false, mode, text });
    }

    return jsonResponse(200, { ok: true, mode, text: rawText.toString() });
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
