// netlify/functions/solve.js
// Netlify Functions (Node 18+) → global fetch 사용 (node-fetch 불필요)

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-5.1-mini";

// ---- 공통 유틸 ----
function clip(str, max) {
  if (!str) return "";
  str = String(str).replace(/\r/g, "");
  if (str.length <= max) return str;
  return str.slice(-max); // 뒤쪽이 선지/질문인 경우가 많아서 뒤에서 자름
}

function makeErrorText(mode, msg) {
  const message = (msg || "AI 호출 중 알 수 없는 오류가 발생했습니다.").trim();

  switch (mode) {
    case "writing":
      return [
        "[ESSAY]",
        "",
        "[FEEDBACK]",
        "에세이를 생성하지 못했습니다.",
        message,
        "",
        "[P] 0.00"
      ].join("\n");

    case "speaking":
      return [
        "[MODEL]",
        "",
        "[P]",
        "0.00",
        "",
        "(설명) 스피킹 답안을 생성하는 중 오류가 발생했습니다.",
        message
      ].join("\n");

    default: // reading / listening / auto
      return [
        "[ANSWER] ?",
        "[P] 0.00",
        "[WHY]",
        message
      ].join("\n");
  }
}

// ---- 프롬프트 생성 ----
function buildPrompt({ mode, ocrText, audioText }) {
  const baseInfo = `
You are an AI that solves official-style TOEFL iBT questions.

OCR text may contain noise, broken lines, or HTML junk. Ignore garbage and infer the intended question.
You must always obey the OUTPUT FORMAT for the current mode.
If your confidence in the final answer is below 0.1, use "?" as the answer.
Always include a probability line "[P] 0.00" between 0 and 1 (your estimate is correct).`;

  const sharedContext = `
[OCR_TEXT]
${ocrText || "(none)"}

[AUDIO_TEXT]
${audioText || "(none)"}
`;

  // READING / LISTENING
  if (mode === "reading" || mode === "listening") {
    return `
${baseInfo}

MODE: ${mode.toUpperCase()}
Task: Read the OCR_TEXT (and AUDIO_TEXT if listening). Identify the TOEFL multiple-choice question and options.
Pick the single best answer (or most likely correct choice if the question is unclear).

If the question asks for a letter/number choice, answer only that label (e.g. "B" or "3").
If the question is unclear but you can guess, still choose one most probable option.
If confidence < 0.1, set answer to "?".

OUTPUT FORMAT (exactly):
[ANSWER] <your final answer, like "B" or "3" or "?" >
[P] <probability between 0 and 1, e.g. 0.78>
[WHY]
- Brief Korean explanation of why, based on the passage.
- One line per option explaining why others are wrong, if possible.

${sharedContext}
`;
  }

  // WRITING
  if (mode === "writing") {
    return `
${baseInfo}

MODE: WRITING
Task: Use OCR_TEXT (and AUDIO_TEXT if useful) to infer the TOEFL writing prompt (integrated or discussion).
Write a high-scoring model answer. Assume a realistic TOEFL time limit.

Length: about 150-225 English words total. Do NOT exceed ~250 words.

OUTPUT FORMAT (exactly):
[ESSAY]
<English essay here>

[FEEDBACK]
- In Korean, very short feedback on structure/content/grammar.
- Mention 2~3 strengths and 2~3 weaknesses.

[P] <probability between 0 and 1 that this essay matches the prompt reasonably well>

${sharedContext}
`;
  }

  // SPEAKING
  if (mode === "speaking") {
    return `
${baseInfo}

MODE: SPEAKING
Goal: Generate the best possible TOEFL iBT speaking answer script that the student can read out loud.

Use OCR_TEXT (and AUDIO_TEXT only if it clearly contains the speaking QUESTION, not an answer).
Even if OCR_TEXT includes multiple-choice options (A/B/C/D), IGNORE those options.
Do NOT solve it as a multiple-choice question. Do NOT output letters like "A", "B", "C" as the final answer.

Assume the student speaks rather slowly and has only 15 seconds of preparation time before speaking.
You must respond as quickly as possible. Keep internal reasoning minimal and focus on emitting the final script.

Length: about 55-80 English words. NEVER exceed 90 words.

Pronunciation help:
- For a few words (around 3–6) that are likely hard to pronounce (academic vocabulary, long words),
  add Korean Hangul pronunciation in parentheses RIGHT AFTER the word.
- Example: sociology (소시오럴러지)
- Do NOT add pronunciation to easy words like "I", "think", "because", "very", etc.
- Keep the script readable; do not add pronunciation for every word.

OUTPUT FORMAT (exactly):
[MODEL]
<English speaking script only, full sentences, with some words followed by Korean pronunciation in parentheses>

[P]
<probability between 0 and 1 that this script is appropriate for the task>

${sharedContext}
`;
  }

  // AUTO / 기타
  return `
${baseInfo}

MODE: AUTO
When unsure of the section, assume READING-style multiple-choice.
Use the same OUTPUT FORMAT as READING:
[ANSWER]
[P]
[WHY]

${sharedContext}
`;
}

// ---- OpenRouter 호출 ----
async function callOpenRouter(prompt, mode) {
  if (!OPENROUTER_API_KEY) {
    return {
      ok: false,
      text: makeErrorText(
        mode,
        "OpenRouter API key가 설정되어 있지 않습니다. Netlify 환경변수 OPENROUTER_API_KEY를 확인하세요."
      )
    };
  }

  const body = {
    model: OPENROUTER_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are an expert TOEFL iBT AI solver. Follow the requested output format strictly."
      },
      { role: "user", content: prompt }
    ]
  };

  const fetchOptions = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
      "X-Title": "answer-site-toefl-helper"
    },
    body: JSON.stringify(body)
  };

  let res;
  let rawText = "";

  try {
    // 별도의 AbortController/타임아웃 사용 X
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", fetchOptions);
    rawText = await res.text();
  } catch (e) {
    return {
      ok: false,
      text: makeErrorText(
        mode,
        `OpenRouter 요청 중 네트워크 오류 또는 타임아웃이 발생했습니다. (클라이언트)\n에러: ${e.toString()}`
      )
    };
  }

  const trimmed = rawText.trim();
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const looksHtml =
    ct.includes("text/html") ||
    /^<!?html/i.test(trimmed.slice(0, 20)) ||
    /^<head/i.test(trimmed.slice(0, 20)) ||
    /^<body/i.test(trimmed.slice(0, 20));

  if (!res.ok || looksHtml) {
    return {
      ok: false,
      text: makeErrorText(
        mode,
        `OpenRouter 응답 오류 (status=${res.status}). Inactivity Timeout 같은 HTML 에러 페이지가 왔을 수 있습니다. 잠시 후 다시 시도하세요.`
      )
    };
  }

  let json;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    return {
      ok: false,
      text: makeErrorText(
        mode,
        "OpenRouter 응답을 JSON으로 해석할 수 없습니다.\nraw 일부:\n" +
          trimmed.slice(0, 500)
      )
    };
  }

  const content =
    json.choices &&
    json.choices[0] &&
    json.choices[0].message &&
    json.choices[0].message.content;

  if (!content) {
    return {
      ok: false,
      text: makeErrorText(
        mode,
        "OpenRouter 응답에 content 필드가 없습니다."
      )
    };
  }

  return { ok: true, text: content.trim() };
}

// ---- Netlify handler ----
exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: "Invalid JSON body" };
  }

  let { mode, ocrText, audioText } = body;
  mode = (mode || "auto").toLowerCase();

  const cleanOcr = clip(ocrText || "", 2500);
  const cleanAudio = clip(audioText || "", 1200);

  const prompt = buildPrompt({
    mode,
    ocrText: cleanOcr,
    audioText: cleanAudio
  });

  const result = await callOpenRouter(prompt, mode);

  return {
    statusCode: 200,
    body: result.text
  };
};
