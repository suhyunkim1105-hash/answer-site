// netlify/functions/solve.js

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || "openai/gpt-5.1-mini";

function clip(str, max) {
  if (!str) return "";
  str = String(str).replace(/\r/g, "");
  if (str.length <= max) return str;
  return str.slice(-max); // 뒤쪽이 보통 문제/선지라서 뒤에서 자름
}

function buildPrompt({ mode, ocrText, audioText }) {
  const baseInfo = `
You are an AI that solves official-style TOEFL iBT questions.
OCR text may contain noise, break lines, or include HTML junk. Ignore garbage and guess the most likely intended question.

Your must always obey the OUTPUT FORMAT for the current mode.
If your confidence in the final answer is below 0.1, use "?" as the answer.
Always include a probability line "[P] 0.00" between 0 and 1 (your estimate that your answer is correct).`;

  const sharedContext = `
[OCR_TEXT]
${ocrText || "(none)"}

[AUDIO_TEXT]
${audioText || "(none)"}  
`;

  if (mode === "reading" || mode === "listening") {
    return `
${baseInfo}

MODE: ${mode.toUpperCase()}
Task: Read the OCR_TEXT (and AUDIO_TEXT if listening). Identify the TOEFL multiple-choice question and options.
Pick the single best answer (or most likely correct choice if question is unclear).

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

  if (mode === "writing") {
    return `
${baseInfo}

MODE: WRITING
Task: Use OCR_TEXT (and AUDIO_TEXT if useful) to infer the TOEFL writing prompt.
Write a high-scoring model answer. Assume time limit like TOEFL integrated (20분) / discussion (10분).

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

  if (mode === "speaking") {
    return `
${baseInfo}

MODE: SPEAKING
Task: From OCR_TEXT you may infer the speaking question. AUDIO_TEXT contains the student's spoken answer (with possible STT errors).
Evaluate the student's answer and also propose the best possible model answer.

Assume TOEFL speaking time limit (about 45~60 seconds).
Model answer length: about 120-160 English words (do NOT exceed ~180 words).

OUTPUT FORMAT (exactly):
[EVAL]
- In Korean, briefly rate the student's answer (0~4 느낌) and list strengths/weaknesses.
- Focus on content, organization, and language use.

[MODEL]
<English model answer, about 120-160 words, something a 4점 답안 수준>

[KOREAN]
- In Korean, 2~3 concrete tips on how to improve.
- Keep it short.

[P] <probability between 0 and 1 that your evaluation and model answer are appropriate>

${sharedContext}
`;
  }

  // fallback / auto
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

function ok(body) {
  return { statusCode: 200, body };
}

function bad(status, msg) {
  return { statusCode: status, body: msg };
}

async function callOpenRouter(prompt) {
  if (!OPENROUTER_API_KEY) {
    return {
      ok: false,
      text: "[ANSWER] ?\n[P] 0.00\n[WHY]\nOpenRouter API key가 설정되어 있지 않습니다."
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000); // 25초 하드 타임아웃

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

  let res;
  let rawText = "";

  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site-toefl-helper"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    rawText = await res.text();
  } catch (e) {
    clearTimeout(timeoutId);
    return {
      ok: false,
      text:
        "[ANSWER] ?\n[P] 0.00\n[WHY]\nOpenRouter 요청 중 네트워크/타임아웃 오류가 발생했습니다.\n" +
        `에러: ${e.toString()}`
    };
  } finally {
    clearTimeout(timeoutId);
  }

  const trimmed = rawText.trim();
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const looksHtml =
    ct.includes("text/html") ||
    /^<!?html/i.test(trimmed.slice(0, 20)) ||
    /^<head/i.test(trimmed.slice(0, 20)) ||
    /^<body/i.test(trimmed.slice(0, 20));

  if (!res.ok || looksHtml) {
    // 여기서 바로 HTML 에러를 먹어버리고, 깔끔한 텍스트만 돌려보냄
    return {
      ok: false,
      text:
        "[ANSWER] ?\n[P] 0.00\n[WHY]\n" +
        `OpenRouter 응답 오류 (status=${res.status}).\n` +
        "Inactivity Timeout 등 HTML 에러 페이지가 왔습니다. 잠시 후 다시 시도하세요."
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
    return bad(405, "Method Not Allowed");
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return bad(400, "Invalid JSON body");
  }

  let { mode, ocrText, audioText } = body;
  mode = (mode || "auto").toLowerCase();

  const cleanOcr   = clip(ocrText || "", 2500);
  const cleanAudio = clip(audioText || "", 1200);

  const prompt = buildPrompt({
    mode,
    ocrText: cleanOcr,
    audioText: cleanAudio
  });

  // OpenRouter 호출
  const result = await callOpenRouter(prompt);

  // 항상 200 + text 로 돌려보내서, remote.html에서 그대로 파싱하도록 한다.
  return ok(result.text);
};

