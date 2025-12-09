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
    // Writing: 통합+디스커션 둘 다 커버, 프롬프트 최대한 짧게
    system = `
You are an expert TOEFL iBT Writing tutor.

You get:
- OCR_TEXT: reading passage and/or writing question.
- AUDIO_TEXT: listening passage transcript (may be empty).

Task:
- Decide whether this is an integrated writing task or an academic discussion.
- Write a high-scoring model answer that directly answers the question.

Length:
- About 150-220 English words.
- Do NOT exceed about 240 words.

Style:
- Clear, natural academic English.
- Organized with introduction, 1-2 body paragraphs, brief conclusion.
- For academic discussion, sound like a student giving a concise but thoughtful post.

Output format (exactly):

[ESSAY]
<English essay here>
[FEEDBACK]
2-4 sentences in Korean:
- 한 줄로 전체 평가
- 중요한 표현 3-7개 (영어 표현만, 쉼표로 나열)
`.trim();

    user = `
You must only answer in the format described above.

OCR_TEXT:
${cleanOCR || "(none)"}

AUDIO_TEXT:
${cleanAUDIO || "(none)"}
`.trim();

    maxTokens = 512;
    temperature = 0.25;
  } else if (mode === "speaking") {
    system = `
You are an expert TOEFL iBT Speaking tutor.

You get:
- OCR_TEXT: on-screen instructions or reading.
- AUDIO_TEXT: transcript of the listening question/conversation (NOT the student's answer).

Task:
- Based on OCR_TEXT and AUDIO_TEXT, generate ONE short, high-quality model spoken answer.
- The user will read it aloud.

Length:
- About 40-70 English words (10-15 seconds).
- 2-4 sentences.
- Do NOT exceed 90 words.

Pronunciation help:
- Choose 3-7 important or difficult English words from your answer.
- For each, give a simple Korean hangul approximation (no IPA).

Output format (exactly):

[ANSWER]
Short English script for the user to read aloud.
[WORDS]
word1 (워드1), word2 (워드2), ...
[KOREAN]
1-2 Korean sentences:
- 핵심 내용 요약
- 발음/억양 팁 한두 개
`.trim();

    user = `
You must only answer in the format described above.

OCR_TEXT:
${cleanOCR || "(none)"}

AUDIO_TEXT:
${cleanAUDIO || "(none)"}
`.trim();

    maxTokens = 256;
    temperature = 0.25;
  } else {
    system = `
You are an expert TOEFL iBT Reading and Listening tutor.

You get:
- OCR_TEXT: passage, question, answer choices, etc.
- AUDIO_TEXT: listening transcript (may be empty).

Task:
1. Identify the CURRENT question (usually near the end of OCR_TEXT).
2. Choose the best answer choice.

Important:
- If choices have labels (1-4, A-D, etc.), answer with those labels.
- If choices only have bullets (●, ○, -, etc.) or sentences in a list, infer implicit labels "1, 2, 3, 4" from top to bottom and answer using those labels.
- For questions that ask for TWO or THREE answers, return ALL labels separated by commas (e.g., "B, D" or "2, 4").
- For ordering/sequence questions, answer with a short sequence like "3-1-4-2" or "B-D-A-C".
- For summary/table/drag questions, compress your final choice into a single label or short sequence.
- For sentence insertion questions with small squares (▢, □, ■, etc.), just choose the option label for the best insertion point.

Uncertainty:
- If OCR_TEXT is badly damaged and you are less than 0.1 confident, answer "?" and explain why.

Output format (exactly):

[ANSWER] <label, sequence, or "?" only>
[P] <probability 0.00-1.00 (your confidence)>
[WHY]
2-5 bullet points in Korean:
- 왜 이 답이 가장 가능성이 높은지
- 다른 선택지가 틀린 이유
`.trim();

    user = `
You must only answer in the format described above.

MODE: ${mode.toUpperCase()}

OCR_TEXT:
${cleanOCR || "(none)"}

AUDIO_TEXT:
${cleanAUDIO || "(none)"}
`.trim();

    maxTokens = 512;
    temperature = 0.2;
  }

  return { system, user, maxTokens, temperature };
}

// HTML 에러 페이지 감지
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

async function callOpenRouter({
  mode,
  system,
  user,
  maxTokens,
  temperature,
  apiKey,
  baseUrl
}) {
  const controller = new AbortController();
  const timeoutMs =
    mode === "speaking"
      ? 15000
      : mode === "writing"
      ? 28000
      : 22000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = {
      // 안정성/속도 위해 모델 고정
      model: "openai/gpt-4o-mini",
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
      return { ok: false, message: msg };
    }

    let data;
    try {
      data = JSON.parse(rawBody);
    } catch (e) {
      return {
        ok: false,
        message: "OpenRouter 응답을 JSON으로 해석하지 못했습니다."
      };
    }

    if (!data || typeof data !== "object") {
      return {
        ok: false,
        message: "OpenRouter 응답 형식이 예상과 다릅니다."
      };
    }

    if (data.error) {
      const errMsg =
        (typeof data.error === "string"
          ? data.error
          : data.error.message || "알 수 없는 OpenRouter 오류");
      return {
        ok: false,
        message: "OpenRouter 오류: " + errMsg
      };
    }

    const choices = Array.isArray(data.choices) ? data.choices : [];
    if (choices.length === 0) {
      return {
        ok: false,
        message: "OpenRouter 응답에 choices가 없습니다."
      };
    }

    const choice = choices[0];
    let rawText = "";

    if (choice.message) {
      rawText = extractContentFromMessage(choice.message);
    }
    if (!rawText && choice.delta) {
      rawText = extractContentFromMessage(choice.delta);
    }
    if (!rawText && typeof choice.text === "string") {
      rawText = choice.text;
    }
    if (!rawText && typeof choice.content === "string") {
      rawText = choice.content;
    }

    if (!rawText || !rawText.toString().trim()) {
      return {
        ok: false,
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
    return { ok: false, message: msg };
  } finally {
    clearTimeout(timeout);
  }
}

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

  const baseUrl =
    process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

  const result = await callOpenRouter({
    mode,
    system,
    user,
    maxTokens,
    temperature,
    apiKey,
    baseUrl
  });

  if (result.ok) {
    return jsonResponse(200, { ok: true, mode, text: result.text });
  }

  const text = makeErrorText(mode, result.message);
  return jsonResponse(200, { ok: false, mode, text });
};
