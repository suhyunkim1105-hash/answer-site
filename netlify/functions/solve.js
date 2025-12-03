// netlify/functions/solve.js
// Netlify Functions (Node 18+) → global fetch 사용, node-fetch 불필요

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-5.1-mini";

// ===== 유틸 =====
function clip(str, max) {
  if (!str) return "";
  str = String(str).replace(/\r/g, "");
  if (str.length <= max) return str;
  // 지문 뒤쪽이 보통 문제/선지라서 뒤에서 자름
  return str.slice(-max);
}

function buildPrompt({ mode, ocrText, audioText }) {
  const baseInfo = `
You are an AI that solves official-style TOEFL iBT questions.

OCR text may contain noise, broken lines, or HTML junk. Ignore garbage and infer the intended question.
You must always obey the OUTPUT FORMAT for the current mode.
If your confidence in the final answer is below 0.1, use "?" as the answer.
Always include a probability line "[P] 0.00" between 0 and 1 (your estimate that your answer is correct).`;

  const sharedContext = `
[OCR_TEXT]
${ocrText || "(none)"}

[AUDIO_TEXT]
${audioText || "(none)"}
`;

  // ---- READING / LISTENING: 객관식 정답 ----
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

  // ---- WRITING: 통합형/디스커션 모범 에세이 ----
  if (mode === "writing") {
    return `
${baseInfo}

MODE: WRITING
Task: Use OCR_TEXT (and AUDIO_TEXT if useful) to infer the TOEFL writing prompt (integrated or discussion).
Write a high-scoring model answer. Assume a realistic TOEFL time limit.

Length: about 220-320 English words total. Do NOT exceed ~350 words.

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

  // ---- SPEAKING: 읽을 스크립트만 ----
  if (mode === "speaking") {
    return `
${baseInfo}

MODE: SPEAKING
Goal: Generate the best possible TOEFL iBT speaking answer script that the student can read out loud.

Use OCR_TEXT (and AUDIO_TEXT only if it clearly contains the speaking QUESTION, not an answer).
Even if OCR_TEXT includes multiple-choice options (A/B/C/D), IGNORE those options.
Do NOT solve it as a multiple-choice question. Do NOT output letters like "A", "B", "C" as the final answer.

Instead, infer the situation and question, then produce a natural first-person spoken response.

Length: 80-120 English words. This should fit in about 45 seconds at a natural speaking speed.
NEVER exceed 130 words.

OUTPUT FORMAT (exactly):
[MODEL]
<English speaking script only, full sentences, first-person, natural speaking style>
(Do NOT include Korean here.)

[P]
<probability between 0 and 1 that this script is appropriate for the task>

${sharedContext}
`;
  }

  // ---- AUTO / 기타: 리딩 스타일로 처리 ----
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

// OpenRouter 호출 + HTML/타임아웃 방어
async function callOpenRouter(prompt) {
  if (!OPENROUTER_API_KEY) {
    return {
      ok: false,
      text:
        "[ANSWER] ?\n[P] 0.00\n[WHY]\nOpenRouter API key가 설정되어 있지 않습니다."
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
      {
        role: "user",
        content: prompt
      }
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

  // 25초 타임아웃
  let controller = null;
  let timeoutId = null;
  if (typeof AbortController !== "undefined") {
    controller = new AbortController();
    fetchOptions.signal = controller.signal;
    timeoutId = setTimeout(() => controller.abort(), 25000);
  }

  let res;
  let rawText = "";

  try {
    res = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      fetchOptions
    );
    rawText = await res.text();
  } catch (e) {
    if (timeoutId) clearTimeout(timeoutId);
    return {
      ok: false,
      text:
        "[ANSWER] ?\n[P] 0.00\n[WHY]\nOpenRouter 요청 중 네트워크/타임아웃 오류가 발생했습니다.\n" +
        `에러: ${e.toString()}`
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  const trimmed = rawText.trim();
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const looksHtml =
    ct.includes("text/html") ||
    /^<!?html/i.test(trimmed.slice(0, 20)) ||
    /^<head/i.test(trimmed.slice(0, 20)) ||
    /^<body/i.test(trimmed.slice(0, 20));

  // HTTP 에러나 HTML 에러 페이지면 여기서 잘라버림
  if (!res.ok || looksHtml) {
    return {
      ok: false,
      text:
        "[ANSWER] ?\n[P] 0.00\n[WHY]\n" +
        `OpenRouter 응답 오류 (status=${res.status}). Inactivity Timeout 등 HTML 에러 페이지가 왔습니다. 잠시 후 다시 시도하세요.`
    };
  }

  // JSON 파싱
  let json;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    return {
      ok: false,
      text:
        "[ANSWER] ?\n[P] 0.00\n[WHY]\n" +
        "OpenRouter 응답을 JSON으로 해석할 수 없습니다.\n" +
        `raw: ${trimmed.slice(0, 500)}`
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
      text:
        "[ANSWER] ?\n[P] 0.00\n[WHY]\n" +
        "OpenRouter 응답에 content가 없습니다."
    };
  }

  return { ok: true, text: content.trim() };
}

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

  const result = await callOpenRouter(prompt);

  // 프론트 쪽은 항상 "텍스트만" 받게 200으로 응답
  return { statusCode: 200, body: result.text };
};

