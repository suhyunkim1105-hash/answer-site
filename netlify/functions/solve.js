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
 * OpenRouter message 객체에서 content를 최대한 뽑아내는 함수
 */
function extractContentFromMessage(msg) {
  if (!msg) return "";

  const c = msg.content;

  // 1) content가 문자열
  if (typeof c === "string") return c;

  // 2) content가 배열 (여러 파트)
  if (Array.isArray(c)) {
    const parts = [];
    for (const part of c) {
      if (!part) continue;

      if (typeof part === "string") {
        parts.push(part);
        continue;
      }

      if (typeof part === "object") {
        if (part.type === "text" && typeof part.text === "string") {
          parts.push(part.text);
          continue;
        }
        if (typeof part.text === "string") {
          parts.push(part.text);
          continue;
        }
        if (part.text && typeof part.text.value === "string") {
          parts.push(part.text.value);
          continue;
        }
        if (typeof part.value === "string") {
          parts.push(part.value);
          continue;
        }
      }
    }
    return parts.join("\n").trim();
  }

  // 3) content가 객체
  if (typeof c === "object" && c !== null) {
    if (typeof c.text === "string") return c.text;
    if (c.text && typeof c.text.value === "string") return c.text.value;
    if (typeof c.value === "string") return c.value;
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
    // Writing: Integrated 20분, Discussion 10분 → 150~225단어 현실적인 분량
    system = `
You are an expert TOEFL iBT Writing tutor.

You will receive:
- OCR_TEXT: the reading passage and/or the writing question.
- AUDIO_TEXT: the transcript of the listening passage for an integrated task. It may be empty.

Test constraints:
- The real TOEFL iBT Writing section has two tasks:
  - Integrated Writing: 20 minutes to write.
  - Writing for an Academic Discussion: 10 minutes to write.
- Your model answer must be realistic for those time limits.

Task:
- Infer the TOEFL writing task (integrated or academic discussion).
- Write a high-scoring model answer that directly answers the question.

Length:
- Aim for about 150-220 English words total.
- Do NOT exceed about 240 words.

Style:
- Clear, natural academic English.
- Well organized with an introduction, 1-2 body paragraphs, and a brief conclusion.
- For academic discussion tasks, sound like a student giving a concise but thoughtful post.

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

    maxTokens = 512; // 너무 크지 않게 줄여서 속도 확보
    temperature = 0.25;
  } else if (mode === "speaking") {
    // Speaking: 섹션 16~17분 / 문항당 45~60초 발화
    // 여기서는 10~15초(40~70단어)짜리 짧은 템플릿 스크립트
    system = `
You are an expert TOEFL iBT Speaking tutor.

You will receive:
- OCR_TEXT: the on-screen instructions and any reading part.
- AUDIO_TEXT: the transcript of the listening part (the question or conversation).

Important:
- AUDIO_TEXT may contain the audio question AND conversation, but it is NOT the student's answer.
- Always treat OCR_TEXT and AUDIO_TEXT as the task prompt only.
- You must create a brand-new model answer.

Task:
- Based on OCR_TEXT and AUDIO_TEXT, generate a single high-quality model spoken answer that the user can read aloud.
- The real TOEFL tasks give 45-60 seconds to speak, but the user wants a SHORT template.
- So the answer must be very compact and easy to pronounce.

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

    maxTokens = 256; // 짧은 답
    temperature = 0.25;
  } else {
    // reading / listening 공통
    system = `
You are an expert TOEFL iBT Reading and Listening tutor. You solve ONLY TOEFL-style questions.

You will receive:
- OCR_TEXT: text recognized from the screen (passages, questions, answer choices, etc.).
- AUDIO_TEXT: transcript of the audio (for listening questions). It may be empty.

Tasks:
1. Understand what the current question is: reading question, listening question, summary, sentence insertion, ordering, etc.
2. Find the single best answer choice (or choices) for the current question.

Important:
- Focus ONLY on the CURRENT question near the end of the OCR_TEXT.
- If there are labeled answer choices like 1-4, A-D, etc., choose from them.
- If the options do NOT show labels (only empty circles ●/○, bullets, dashes, or just sentences in a list),
  infer implicit labels such as "1, 2, 3, 4" from top to bottom and answer using that label.
- For "Select TWO/THREE answers" type, return ALL labels separated by commas (e.g., "B, D" or "2, 4").
- For ordering / sequence questions, compress your final answer into a short sequence like "3-1-4-2" or "B-D-A-C".
- For summary / drag / table questions, still convert your reasoning into a single label or short sequence that clearly matches the options.
- For sentence insertion questions with small squares (▢, □, ■, etc.), choose the option that indicates the correct position. Do NOT rewrite the whole paragraph.

Uncertainty:
- If the OCR_TEXT is badly damaged and you are less than 0.1 confident in any answer,
  output "?" as the answer and explain why.

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
    temperature = 0.2;
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

/**
 * OpenRouter 한 번 호출
 * - ok: { ok:true, text }
 * - fail: { ok:false, code, message }
 */
async function callOpenRouterOnce({
  modelName,
  system,
  user,
  maxTokens,
  temperature,
  mode,
  apiKey,
  baseUrl
}) {
  const controller = new AbortController();
  const timeoutMs =
    mode === "speaking"
      ? 15000 // 스피킹은 빠르게
      : mode === "writing"
      ? 28000 // 라이팅은 Netlify 한계(30초) 바로 아래
      : 22000; // 리딩/리스닝

  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = {
      model: modelName,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      max_tokens: maxTokens,
      temperature
    };

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
      const msg = !res.ok
        ? "OpenRouter 호출 실패 (status " + res.status + ")."
        : "OpenRouter 쪽에서 HTML 에러 페이지를 돌려줬습니다.";
      return { ok: false, code: "HTTP_OR_HTML", message: msg };
    }

    let data;
    try {
      data = JSON.parse(rawBody);
    } catch (e) {
      return {
        ok: false,
        code: "PARSE",
        message: "OpenRouter 응답을 JSON으로 해석하지 못했습니다."
      };
    }

    if (!data || typeof data !== "object") {
      return {
        ok: false,
        code: "FORMAT",
        message: "OpenRouter 응답 형식이 예상과 다릅니다."
      };
    }

    if (data.error) {
      const errMsg =
        (typeof data.error === "string"
          ? data.error
          : data.error.message || "알 수 없는 OpenRouter 오류") || "";
      return {
        ok: false,
        code: "REMOTE_ERROR",
        message: "OpenRouter 오류: " + errMsg
      };
    }

    const choices = Array.isArray(data.choices) ? data.choices : [];
    if (choices.length === 0) {
      return {
        ok: false,
        code: "NO_CHOICES",
        message: "OpenRouter 응답에 choices가 없습니다."
      };
    }

    const choice = choices[0];
    let rawText = "";

    // 1) message 기반
    if (choice.message) {
      rawText = extractContentFromMessage(choice.message);
    }

    // 2) delta 기반 (일부 스트리밍 스타일 응답)
    if (!rawText && choice.delta) {
      rawText = extractContentFromMessage(choice.delta);
    }

    // 3) text 필드
    if (!rawText && typeof choice.text === "string") {
      rawText = choice.text;
    }

    // 4) content 필드가 문자열인 경우
    if (!rawText && typeof choice.content === "string") {
      rawText = choice.content;
    }

    if (!rawText || !rawText.toString().trim()) {
      return {
        ok: false,
        code: "NO_CONTENT",
        message:
          "OpenRouter 응답에서 완성된 텍스트를 찾지 못했습니다. 사용 중인 모델이 reasoning 전용이거나 응답 포맷이 달라졌을 수 있습니다."
      };
    }

    return { ok: true, text: rawText.toString() };
  } catch (e) {
    const isAbort = e && e.name === "AbortError";
    const msg = isAbort
      ? "요청 시간이 너무 오래 걸려 중단되었습니다. (플랫폼 제한상 30초 이상 대기할 수 없습니다.)"
      : "OpenRouter 요청 중 오류: " + (e && e.message ? e.message : e);
    return {
      ok: false,
      code: isAbort ? "TIMEOUT" : "NETWORK",
      message: msg
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ----------------- Netlify Handler -----------------
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
  const mode = ["reading", "listening", "writing", "speaking"].includes(
    modeRaw
  )
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

  const envModel = process.env.OPENROUTER_MODEL;
  const primaryModel =
    envModel && envModel.trim() ? envModel.trim() : "openai/gpt-4o-mini";
  const baseUrl =
    process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

  // 1차: 설정된 모델 사용
  const first = await callOpenRouterOnce({
    modelName: primaryModel,
    system,
    user,
    maxTokens,
    temperature,
    mode,
    apiKey,
    baseUrl
  });

  if (first.ok) {
    return jsonResponse(200, { ok: true, mode, text: first.text });
  }

  // 1차에서 "내용 없음"이고, 설정 모델이 gpt-4o-mini가 아니면 예비 모델로 재시도
  if (first.code === "NO_CONTENT" && primaryModel !== "openai/gpt-4o-mini") {
    const second = await callOpenRouterOnce({
      modelName: "openai/gpt-4o-mini",
      system,
      user,
      maxTokens,
      temperature,
      mode,
      apiKey,
      baseUrl
    });

    if (second.ok) {
      return jsonResponse(200, { ok: true, mode, text: second.text });
    }

    const text = makeErrorText(
      mode,
      "설정된 모델과 예비 모델(gpt-4o-mini) 모두에서 완성된 텍스트를 얻지 못했습니다. " +
        (second.message || "")
    );
    return jsonResponse(200, { ok: false, mode, text });
  }

  // 그 외 에러
  const text = makeErrorText(mode, first.message);
  return jsonResponse(200, { ok: false, mode, text });
};
