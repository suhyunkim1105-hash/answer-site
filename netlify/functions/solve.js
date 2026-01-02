// netlify/functions/solve.js

const STOP_TOKEN = (process.env.STOP_TOKEN || "XURTH").trim() || "XURTH";
const MODEL_NAME = (process.env.MODEL_NAME || "openai/gpt-5.1").trim();
// LLM 응답 타임아웃 (ms)
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 15000);
// 최대 출력 토큰 (실제 사용은 300으로 캡)
const MAX_OUTPUT_TOKENS_ENV = Number(process.env.MAX_OUTPUT_TOKENS || 2500);
const MAX_OUTPUT_TOKENS = Math.min(
  Number.isFinite(MAX_OUTPUT_TOKENS_ENV) ? MAX_OUTPUT_TOKENS_ENV : 2500,
  300
);

function safeJson(str) {
  try {
    return JSON.parse(str || "{}");
  } catch (_) {
    return {};
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(obj)
  };
}

// OCR 텍스트에서 문제 번호 후보 추출
function extractQuestionNumbers(ocrText) {
  if (!ocrText) return [];

  const numbers = new Set();
  const lineRe = /^\s*([0-4]?\d)\s*[\.\)]/;      // "01.", "1)", "10." 등
  const inlineRe = /\b([0-4]?\d)\s*[\.\)]/g;

  const lines = ocrText.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const m = line.match(lineRe);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 50) numbers.add(n);
    }

    let g;
    while ((g = inlineRe.exec(line))) {
      const n = Number(g[1]);
      if (n >= 1 && n <= 50) numbers.add(n);
    }
  }

  return Array.from(numbers).sort((a, b) => a - b);
}

// 페이지 번호에 따라 대략적인 범위 제한 (이상한 번호 필터용, 너무 빡세게는 안 함)
function clampByPage(page, nums) {
  if (!Array.isArray(nums) || !nums.length) return [];

  const p = Number(page) || 1;
  let min = 1;
  let max = 50;

  if (p === 1) {
    min = 1;
    max = 20;
  } else if (p === 2) {
    min = 10;
    max = 30;
  } else if (p === 3) {
    min = 20;
    max = 40;
  } else if (p >= 4) {
    min = 30;
    max = 50;
  }

  const filtered = nums.filter((n) => n >= min && n <= max);
  if (!filtered.length) return nums;
  return filtered;
}

// 프롬프트 구성
function buildPrompt(ocrText, page, questionNumbers, hits, conf) {
  const numsString =
    questionNumbers && questionNumbers.length
      ? questionNumbers.join(", ")
      : "unknown";

  const reliabilityHint = [
    `- OCR mean confidence: ${conf}`,
    `- Detected number-like patterns (hits): ${hits}`,
    questionNumbers.length
      ? `- Parsed question numbers on this page: ${numsString}`
      : "- Could not reliably parse question numbers (the model must infer them from context)."
  ].join("\n");

  const systemContent = `
You are solving an English multiple-choice exam page from a Korean university transfer test.

You are given:
- Raw OCR text of ONE PAGE of the test.
- This page likely contains ONLY some of the questions (not all 50).
- The page may contain OCR noise (typos, weird spacing, etc.).
- Each question has options A, B, C, D, (sometimes E).
- Underlined or BLANK words might be marked or described by the student.

Your job:
1. Read the OCR text carefully.
2. For each question number that appears on THIS PAGE, choose the MOST LIKELY correct option.
3. NEVER invent question numbers that are clearly not in the text.
4. If you are NOT confident for a specific number, still try to give your best guess, but mark that number as UNSURE later.
5. Do NOT explain your reasoning. Only output answers in the required format.

If question numbers were detected by preprocessing, they are:
${numsString}

OCR reliability info:
${reliabilityHint}

Output format (VERY IMPORTANT):
- Each answer on its own line as: "번호: 옵션대문자"
  - e.g. "3: C"
  - e.g. "10: B"
- 번호는 오름차순으로 정렬.
- If you are unsure about some numbers, add ONE line at the end:
  "UNSURE: 번호1, 번호2, ..."
  - If none are unsure, write "UNSURE:" with nothing after it.
- 마지막 줄에는 반드시 "${STOP_TOKEN}" 를 써라.
- "${STOP_TOKEN}" 앞뒤로 다른 말 쓰지 마라.

절대 지키지 말아야 할 것:
- 불필요한 설명, 한국어 문장, 영어 문장을 추가하지 마라.
- 형식 예:

3: C
4: E
5: D
8: B
10: E
UNSURE: 4, 8
${STOP_TOKEN}
`.trim();

  const userContent = `
[PAGE NUMBER]: ${page}

[OCR TEXT START]
${ocrText}
[OCR TEXT END]
`.trim();

  return { system: systemContent, user: userContent };
}

// LLM 호출 (타임아웃 포함, 한 번만)
async function callModelWithTimeout(prompt) {
  const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) {
    return { ok: false, error: "Missing OPENROUTER_API_KEY env var" };
  }

  const body = {
    model: MODEL_NAME,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user }
    ],
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.1,
    top_p: 1,
    stop: [STOP_TOKEN],
    response_format: { type: "text" }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === "AbortError") {
      return {
        ok: false,
        error: "LLM timeout",
        detail: "모델 응답이 너무 오래 걸려서 중단했어."
      };
    }
    return {
      ok: false,
      error: "LLM fetch failed",
      detail: String(e && e.message ? e.message : e)
    };
  }
  clearTimeout(timer);

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return {
      ok: false,
      error: "LLM JSON parse failed",
      detail: String(e && e.message ? e.message : e)
    };
  }

  if (!resp.ok || data.error) {
    return {
      ok: false,
      error: "LLM HTTP or API error",
      detail: data.error || data
    };
  }

  const choice =
    data &&
    Array.isArray(data.choices) &&
    data.choices.length > 0 &&
    data.choices[0];

  const text =
    choice &&
    choice.message &&
    typeof choice.message.content === "string"
      ? choice.message.content.trim()
      : "";

  if (!text) {
    return {
      ok: false,
      error: "Empty completion from model",
      detail: data
    };
  }

  return { ok: true, text, raw: data };
}

// Netlify 함수 핸들러
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const body = safeJson(event.body);
    const ocrText =
      body && typeof body.text === "string" ? body.text.trim() : "";
    const page = body && body.page != null ? Number(body.page) : 1;
    const hits = body && typeof body.hits === "number" ? body.hits : 0;
    const conf =
      body && typeof body.conf === "number" && Number.isFinite(body.conf)
        ? body.conf
        : 0;

    if (!ocrText) {
      return json(400, { ok: false, error: "Missing OCR text" });
    }

    const rawNumbers = extractQuestionNumbers(ocrText);
    const normalizedNumbers = clampByPage(page, rawNumbers);

    const prompt = buildPrompt(
      ocrText,
      page,
      normalizedNumbers,
      hits,
      conf
    );

    const result = await callModelWithTimeout(prompt);

    if (!result.ok) {
      // 여기서 명확한 에러 메시지 반환 → 프론트에서 {} 안 나옴
      return json(200, {
        ok: false,
        error: result.error || "Unknown LLM error",
        detail: result.detail || null
      });
    }

    const completionText = String(result.text || "").trim();

    return json(200, {
      ok: true,
      text: completionText,
      debug: {
        page,
        rawNumbers,
        normalizedNumbers,
        stopToken: STOP_TOKEN,
        model: MODEL_NAME,
        rawCompletion: completionText
      }
    });
  } catch (e) {
    return json(200, {
      ok: false,
      error: String(e && e.message ? e.message : e)
    });
  }
}


