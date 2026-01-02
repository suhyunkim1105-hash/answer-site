// netlify/functions/solve.js

const STOP_TOKEN = (process.env.STOP_TOKEN || "XURTH").trim() || "XURTH";
const MODEL_NAME = (process.env.MODEL_NAME || "openai/gpt-5.1").trim();
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 2500);

// 안전 JSON 파서
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

// OCR 텍스트에서 문제 번호 후보 뽑기
function extractQuestionNumbers(ocrText) {
  if (!ocrText) return [];

  const numbers = new Set();

  const lineRe = /^\s*([0-4]?\d)\s*[\.\)]/; // "01." "1." "10)" 등
  const inlineRe = /\b([0-4]?\d)\s*[\.\)]/g;

  const lines = ocrText.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // 줄 맨 앞 번호
    const m = line.match(lineRe);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 50) numbers.add(n);
    }

    // 줄 중간 번호들
    let g;
    while ((g = inlineRe.exec(line))) {
      const n = Number(g[1]);
      if (n >= 1 && n <= 50) numbers.add(n);
    }
  }

  return Array.from(numbers).sort((a, b) => a - b);
}

// 페이지 번호별로 대략 문제 범위 추정 (대충이라도 이상한 번호 필터용)
function clampByPage(page, nums) {
  if (!Array.isArray(nums) || !nums.length) return [];

  const p = Number(page) || 1;
  let min = 1;
  let max = 50;

  // 필요하면 여기서 더 세밀하게 조정 가능
  if (p === 1) {
    min = 1;
    max = 15; // 1페이지에서 30번 같은 건 거의 안 나올 거라서
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

  // 혹시 필터하고 나니까 0개면, 그냥 원본 그대로 쓰기
  if (!filtered.length) return nums;
  return filtered;
}

// LLM에게 줄 프롬프트 생성
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

  const instructions = `
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
  - 예) "3: C"
  - 예) "10: B"
- 번호는 오름차순으로 정렬.
- If you are unsure about some numbers, add ONE line at the end:
  "UNSURE: 번호1, 번호2, ..."
  - If none are unsure, write "UNSURE:" with nothing after it.
- 마지막 줄에는 반드시 "${STOP_TOKEN}" 를 써라.
- "${STOP_TOKEN}" 앞뒤로 다른 말 쓰지 마라.

보안 규칙:
- 반드시 위 형식을 지켜라.
- 불필요한 한국어 설명, 영어 설명, 문장 등을 절대 추가하지 마라.
- 출력 예시는 다음과 같다:

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

  return { system: instructions, user: userContent };
}

// OpenRouter + GPT 호출 (한 번)
async function callModelOnce(prompt, page, questionNumbers, hits, conf) {
  const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) {
    return {
      ok: false,
      error: "Missing OPENROUTER_API_KEY env var"
    };
  }

  const body = {
    model: MODEL_NAME,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user }
    ],
    max_tokens: Math.min(MAX_OUTPUT_TOKENS, 1024),
    temperature: 0.1,
    top_p: 1,
    // STOP_TOKEN과 UNSURE 표시 줄에서 멈추도록
    stop: [STOP_TOKEN],
    // gpt-5.1 계열에서 확실히 text로 받기 위해
    response_format: { type: "text" }
  };

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
      body: JSON.stringify(body)
    });
  } catch (e) {
    return {
      ok: false,
      error: "LLM fetch failed",
      detail: String(e && e.message ? e.message : e)
    };
  }

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
    // 여기서 raw 데이터를 같이 넘겨서 디버깅 가능하게
    return {
      ok: false,
      error: "Empty completion from model",
      detail: data
    };
  }

  return {
    ok: true,
    text,
    raw: data
  };
}

// 핸들러
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

    // 1) OCR 텍스트에서 번호 추출
    const rawNumbers = extractQuestionNumbers(ocrText);
    const normalizedNumbers = clampByPage(page, rawNumbers);

    // 2) 프롬프트 생성
    const prompt = buildPrompt(
      ocrText,
      page,
      normalizedNumbers,
      hits,
      conf
    );

    // 3) 모델 한 번 호출
    let result = await callModelOnce(
      prompt,
      page,
      normalizedNumbers,
      hits,
      conf
    );

    // 4) 첫 번째 호출이 "Empty completion" 이면 한 번 더 시도
    if (!result.ok && result.error === "Empty completion from model") {
      // 재시도: stop 토큰을 빼고, max_tokens 줄여서 한번 더 시도
      const retryPrompt = prompt; // 같은 프롬프트 사용
      const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
      if (!apiKey) {
        // 이미 위에서 체크했지만 혹시 모르니
        return json(200, {
          ok: false,
          error: "Missing OPENROUTER_API_KEY env var (retry)"
        });
      }

      const retryBody = {
        model: MODEL_NAME,
        messages: [
          { role: "system", content: retryPrompt.system },
          { role: "user", content: retryPrompt.user }
        ],
        max_tokens: Math.min(MAX_OUTPUT_TOKENS, 768),
        temperature: 0.1,
        top_p: 1,
        response_format: { type: "text" }
        // retry 에서는 stop 제거 (혹시 stop 때문에 비어버렸다면)
      };

      let resp2;
      let data2;
      try {
        resp2 = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Authorization: `Bearer ${apiKey}`,
              "HTTP-Referer":
                "https://beamish-alpaca-e3df59.netlify.app",
              "X-Title": "answer-site"
            },
            body: JSON.stringify(retryBody)
          }
        );
        data2 = await resp2.json();
      } catch (e) {
        // 재시도도 실패하면 그냥 오류 반환
        return json(200, {
          ok: false,
          error:
            "LLM retry failed (network or JSON error). 이 페이지를 다시 촬영해 줘.",
          detail: String(e && e.message ? e.message : e)
        });
      }

      if (!resp2.ok || data2.error) {
        return json(200, {
          ok: false,
          error:
            "LLM retry returned API error. 이 페이지를 다시 촬영해 줘.",
          detail: data2.error || data2
        });
      }

      const choice2 =
        data2 &&
        Array.isArray(data2.choices) &&
        data2.choices.length > 0 &&
        data2.choices[0];

      const text2 =
        choice2 &&
        choice2.message &&
        typeof choice2.message.content === "string"
          ? choice2.message.content.trim()
          : "";

      if (!text2) {
        return json(200, {
          ok: false,
          error:
            "모델이 두 번 모두 빈 응답을 줘서 정답을 만들지 못했어. 이 페이지를 다시 촬영해 줘.",
          detail: data2
        });
      }

      // 재시도 성공
      result = { ok: true, text: text2, raw: data2 };
    }

    if (!result.ok) {
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


