// netlify/functions/solve.js

const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const MODEL_NAME = (process.env.MODEL_NAME || "openai/gpt-5.1").trim();
const STOP_TOKEN = (process.env.STOP_TOKEN || "XURTH").trim();

// 짧게 끊기도록 토큰/시간 줄임 (Netlify 타임아웃 방지)
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 200);
// 기본 8초 정도로 제한
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS || 8000);
const TEMPERATURE = Number(
  process.env.TEMPERATURE != null ? process.env.TEMPERATURE : 0.1
);

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

  // 1) OCR에서 번호 패턴 전체 스캔 (라인 앞만 보지 않음)
  const qInfo = extractQuestionNumbers(ocrText);
  const numbers = qInfo.normalized;
  const numberListStr = numbers.length ? numbers.join(", ") : "";

  console.log("[solve] page", page, {
    rawNumbers: qInfo.raw,
    normalized: numbers
  });

  const cleanedText = normalizeSpaces(ocrText);

  // 2) 프롬프트
  const systemPrompt = `
You are an expert solver of Korean university transfer English multiple-choice exams.
You MUST output only short answers in the required format.
`.trim();

  const userPrompt = `
You are given OCR text from page ${page} of an English multiple-choice exam.

OCR TEXT:
-----------------
${cleanedText}
-----------------

1. Detect which question numbers appear on THIS PAGE.
   - Numbers are 1~50.
   - OCR may misread "05." as "505." or "07." as "707.".
   - Fix those obvious errors (e.g. 505 -> 5, 707 -> 7).
   - The following is a rough list of detected numbers (may be incomplete or noisy):
     ${numberListStr || "(you must infer the numbers yourself)"}

2. Solve ONLY the questions that logically belong to this page.
   - Typically about 10 questions (e.g. 1–10, 11–20, ...).
   - If the question text/choices are too broken, you may still guess, but mark that number as "unsure".

3. OUTPUT FORMAT (STRICT):
   - One line per question in ascending order.
   - Format exactly: "N: X"
       N = question number (integer, 1~50)
       X = option letter (A, B, C, D, or E)
   - Example:
       1: B
       2: A
       3: D

   - After listing all answers, add ONE line:
       UNSURE: n1, n2
     or, if no especially doubtful questions:
       UNSURE:

   - Finally, output the stop token as the LAST line:
       ${STOP_TOKEN}

4. No explanations. No additional text. Just follow the format above.
`.trim();

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];

  // 3) OpenRouter 호출
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
        temperature: Number.isFinite(TEMPERATURE) ? TEMPERATURE : 0.1,
        stop: [STOP_TOKEN]
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
  } catch (e) {
    console.error("[solve] JSON parse error from OpenRouter", String(e));
    return json(200, {
      ok: false,
      error: "OpenRouter JSON parse error"
    });
  }

  const content =
    data?.choices?.[0]?.message?.content?.trim() ||
    data?.choices?.[0]?.delta?.content?.trim() ||
    "";

  if (!content) {
    console.error("[solve] empty completion", data);
    return json(200, {
      ok: false,
      error: "Empty completion from model"
    });
  }

  // 4) 모델 출력 파싱
  const parsed = parseAnswerText(content, numbers);
  console.log("[solve] parsed answers", parsed);

  const displayLines = [];
  const sortedNums = [...parsed.answers.keys()].sort((a, b) => a - b);
  for (const n of sortedNums) {
    displayLines.push(`${n}: ${parsed.answers.get(n)}`);
  }

  if (parsed.unsure.length) {
    displayLines.push(
      `※ 다음 문항은 OCR 인식이 불안해서 정답 신뢰도가 낮습니다: ${parsed.unsure.join(
        ", "
      )}`
    );
  }

  if (parsed.weird.length) {
    displayLines.push(
      `※ 이 페이지에서 예상하지 못한 번호(검토 필요): ${parsed.weird.join(
        ", "
      )}`
    );
  }

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

/* ---------- 번호 추출 / 파싱 유틸 ---------- */

// OCR 전체에서 1~49 + '.' 또는 ')' 패턴을 전부 찾는다.
function extractQuestionNumbers(text) {
  const raw = [];
  const normalized = [];
  const regex = /\b(0?[1-9]|[1-4][0-9])\s*[\)\.]/g;
  let m;
  const seen = new Set();

  while ((m = regex.exec(text)) !== null) {
    const rawNum = m[1];
    raw.push(rawNum);
    const n = normalizeNumber(rawNum);
    if (n != null && n >= 1 && n <= 50 && !seen.has(n)) {
      seen.add(n);
      normalized.push(n);
    }
  }

  normalized.sort((a, b) => a - b);
  return { raw, normalized };
}

// 505 -> 5, 707 -> 7 같은 보정
function normalizeNumber(rawNum) {
  if (!rawNum) return null;
  const s = String(rawNum).replace(/\D/g, "");
  if (!s) return null;

  if (s.length <= 2) return Number(s);

  const m = s.match(/^([1-9])0\1$/); // 505, 707, 808...
  if (m) return Number(m[1]);

  return Number(s.slice(-2)); // 015 -> 15 같은 것
}

function normalizeSpaces(str) {
  return String(str || "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
}

function parseAnswerText(content, hintedNumbers) {
  const hintedSet = new Set(hintedNumbers || []);
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

      // 힌트 범위 밖이면 weird로만 표시하고, 정답은 일단 채택
      if (hintedSet.size && !hintedSet.has(n)) {
        weird.push(n);
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
        .filter((n) => n != null && n >= 1 && n <= 50);
      unsure = Array.from(new Set(list)).sort((a, b) => a - b);
    }
  }

  return { answers, unsure, weird: Array.from(new Set(weird)) };
}

/* ---------- 공통 유틸 ---------- */

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


