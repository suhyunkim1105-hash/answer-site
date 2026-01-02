// netlify/functions/solve.js

const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const MODEL_NAME = (process.env.MODEL_NAME || "openai/gpt-5.1").trim();
const STOP_TOKEN = (process.env.STOP_TOKEN || "XURTH").trim();
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 500);
const TEMPERATURE = Number(
  process.env.TEMPERATURE != null ? process.env.TEMPERATURE : 0.1
);
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS || 25000);

/**
 * Netlify handler
 */
export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method Not Allowed" });
  }

  const body = safeJson(event.body);
  const ocrText =
    body && typeof body.text === "string" ? body.text.trim() : "";
  const page = Number.isFinite(Number(body?.page))
    ? Number(body.page)
    : 1;

  if (!ocrText) {
    return json(400, { ok: false, error: "Missing OCR text" });
  }
  if (!OPENROUTER_API_KEY) {
    return json(500, { ok: false, error: "Missing OPENROUTER_API_KEY" });
  }

  // --- 1) 번호 추출 & 보정 --------------------------------------
  const qInfo = extractQuestionNumbers(ocrText);
  const numbers = qInfo.normalized;
  const numberListStr = numbers.length ? numbers.join(", ") : "";

  console.log("[solve] page", page, {
    rawNumbers: qInfo.raw,
    normalized: numbers
  });

  // --- 2) LLM 프롬프트 구성 -------------------------------------
  const cleanedText = normalizeSpaces(ocrText);

  const systemPrompt = `
You are an expert solver of Korean university transfer English multiple-choice exams.
You always return **only** short answers (question number + option A-E).
`.trim();

  const userPrompt = `
You are given OCR text from page ${page} of an English multiple-choice exam.
The text may include noise, wrong spacing, or misread characters.

OCR TEXT (AS-IS):
-----------------
${cleanedText}
-----------------

1. First, detect which question numbers actually appear on THIS PAGE.
   - Typical format is "01.", "1.", "06)", etc, at the start of a line.
   - OCR sometimes misreads "05." as "505." or "07." as "707.".
   - If you see "505." or "707." etc, interpret them as "5." or "7." respectively.

2. Then solve ONLY the questions that belong to this page.
   - If the following list is non-empty, those are the question numbers
     we detected after post-processing:
     ${numberListStr || "(you must detect them yourself, usually about 10 questions)"}
   - DO NOT invent new question numbers.
   - If some question text or choices are badly broken so that you cannot
     reliably answer, you may still guess a choice, but mark that question
     number as "unsure".

3. OUTPUT FORMAT (STRICT):
   - One line per question in ascending order.
   - Format exactly: "N: X"
     where:
       N = question number (integer)
       X = chosen option (A, B, C, D, or E)
   - Example:
       1: B
       2: A
       3: D

   - After listing all answers, add ONE line for uncertainty:
       UNSURE: n1, n2
     or if there is no especially doubtful question:
       UNSURE:

   - Finally, on the very last line, output the stop token exactly:
       ${STOP_TOKEN}

4. Be concise. No explanations. No Korean. Just follow the format above.
`.trim();

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];

  // --- 3) OpenRouter 호출 ----------------------------------------
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

  let apiResp;
  try {
    apiResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: Number.isFinite(TEMPERATURE) ? TEMPERATURE : 0.1
      })
    });
  } catch (e) {
    clearTimeout(t);
    const msg =
      e && e.name === "AbortError"
        ? "Chat completion timeout"
        : String(e && e.message ? e.message : e);
    console.error("[solve] fetch error", msg);
    return json(200, { ok: false, error: msg });
  }
  clearTimeout(t);

  if (!apiResp.ok) {
    const text = await apiResp.text().catch(() => "");
    console.error("[solve] HTTP error", apiResp.status, text);
    return json(200, {
      ok: false,
      error: `OpenRouter HTTP ${apiResp.status}`,
      detail: text
    });
  }

  let data;
  try {
    data = await apiResp.json();
  } catch (_) {
    data = {};
  }

  const content =
    data?.choices?.[0]?.message?.content?.trim() ||
    data?.choices?.[0]?.delta?.content?.trim() ||
    "";

  if (!content) {
    console.error("[solve] empty completion", data);
    return json(200, {
      ok: false,
      error: "Empty completion from model",
      detail: data
    });
  }

  // --- 4) 모델 출력 파싱 ------------------------------------------
  const parsed = parseAnswerText(content, numbers);
  console.log("[solve] parsed answers", parsed);

  const displayLines = [];

  // 정답 라인
  const sortedNums = [...parsed.answers.keys()].sort((a, b) => a - b);
  for (const n of sortedNums) {
    displayLines.push(`${n}: ${parsed.answers.get(n)}`);
  }

  // 신뢰도 낮은 번호 표시
  if (parsed.unsure.length) {
    displayLines.push(
      `※ 다음 문항은 OCR 인식이 불안해서 정답 신뢰도가 낮습니다: ${parsed.unsure.join(
        ", "
      )}`
    );
  }

  // 모델이 이상한 번호를 만들어낸 경우 (예: 505)
  if (parsed.weird.length) {
    displayLines.push(
      `※ 무시된 비정상 번호(모델 출력): ${parsed.weird.join(", ")}`
    );
  }

  // 마지막 XURTH
  displayLines.push(STOP_TOKEN);

  const finalText = displayLines.join("\n");

  return json(200, {
    ok: true,
    text: finalText,
    debug: {
      page,
      rawNumbers: qInfo.raw,
      normalizedNumbers: numbers,
      stopToken: STOP_TOKEN,
      model: MODEL_NAME,
      rawCompletion: content
    }
  });
}

// ----------------- 유틸 함수들 ----------------------

function extractQuestionNumbers(text) {
  const raw = [];
  const normalized = [];

  const lines = String(text || "").split(/\r?\n/);

  for (const line of lines) {
    // 줄 맨 앞의 숫자 + . or )
    const m = line.match(/^\s*(\d{1,3})\s*[\.\)]/);
    if (!m) continue;
    const rawNum = m[1];
    raw.push(rawNum);

    const n = normalizeNumber(rawNum);
    if (n != null && n >= 1 && n <= 50) {
      if (!normalized.includes(n)) normalized.push(n);
    }
  }

  normalized.sort((a, b) => a - b);
  return { raw, normalized };
}

function normalizeNumber(rawNum) {
  if (!rawNum) return null;
  const s = String(rawNum).replace(/\D/g, "");
  if (!s) return null;

  if (s.length <= 2) {
    return Number(s);
  }

  // 505, 707 같은 패턴 → 5,7
  const m = s.match(/^([1-9])0\1$/);
  if (m) return Number(m[1]);

  // 그 외에는 뒤 2자리만 사용 (예: 015 → 15)
  return Number(s.slice(-2));
}

function normalizeSpaces(str) {
  return String(str || "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
}

function parseAnswerText(content, allowedNumbers) {
  const allowedSet = new Set(allowedNumbers || []);
  const answers = new Map();
  const weird = [];
  let unsure = [];

  const lines = String(content || "").split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // N: X
    const m = line.match(/^(\d{1,3})\s*[:\-]\s*([A-E])/i);
    if (m) {
      const rawNum = m[1];
      const choice = m[2].toUpperCase();
      const n = normalizeNumber(rawNum);

      if (n == null || n < 1 || n > 50) {
        weird.push(rawNum);
        continue;
      }

      if (allowedSet.size && !allowedSet.has(n)) {
        // 이 페이지 번호 범위 밖이면 weird로 처리
        weird.push(rawNum);
        continue;
      }

      answers.set(n, choice);
      continue;
    }

    // UNSURE: ...
    const u = line.match(/^UNSURE\s*:\s*(.*)$/i);
    if (u) {
      const list = u[1]
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => normalizeNumber(x))
        .filter((n) => n != null && (!allowedSet.size || allowedSet.has(n)));
      unsure = Array.from(new Set(list)).sort((a, b) => a - b);
    }
  }

  return { answers, unsure, weird: Array.from(new Set(weird)) };
}

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

