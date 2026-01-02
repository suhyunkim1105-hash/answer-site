// netlify/functions/solve.js

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const body = safeJson(event.body);
    const text = body && typeof body.text === "string" ? body.text.trim() : "";
    const page = body && Number.isFinite(Number(body.page)) ? Number(body.page) : 1;

    if (!text) {
      return json(400, { ok: false, error: "Missing text" });
    }

    // 1) 문제 번호 추출
    const rawNumbers = extractRawNumbers(text);
    const normalizedNumbers = normalizeNumbers(rawNumbers);

    const stopToken = (process.env.STOP_TOKEN || "XURTH").trim() || "XURTH";

    // 모델 / API 설정
    const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
    if (!apiKey) {
      return json(500, { ok: false, error: "Missing OPENROUTER_API_KEY env var" });
    }

    const apiBase =
      (process.env.LLM_API_BASE || "").trim() ||
      "https://openrouter.ai/api/v1";

    const model =
      (process.env.LLM_MODEL || "").trim() ||
      "openai/gpt-4.1";

    // 번호가 하나도 안 잡혀도, 그래도 LLM에 한 번 맡겨본다.
    const numbersForPrompt =
      normalizedNumbers.length > 0 ? normalizedNumbers : inferFallbackNumbers(text);

    const numberListStr =
      numbersForPrompt.length > 0 ? numbersForPrompt.join(", ") : "(없음)";

    const systemPrompt = [
      "You are an expert English exam solver for Korean university transfer exams.",
      "You receive OCR text of ONE printed test page and a list of question numbers detected on that page.",
      "The OCR text can be noisy: punctuation may be wrong, some characters may be corrupted, and there may be stray symbols like @ or #.",
      "Your job is to choose the BEST answer choice (A, B, C, D, or E) for EACH question number in the given list, based on the OCR text.",
      "",
      "VERY IMPORTANT RULES:",
      "1. You MUST answer for EVERY question number in the given list.",
      "2. For each number N in the list, output EXACTLY ONE line with the format:",
      '   \"N: X\"',
      "   where X is one of: A, B, C, D, E, or 'n/a' if it is truly impossible to infer.",
      "3. Do NOT output answers for numbers that are NOT in the given list.",
      "4. At the end, output one more line:",
      '   \"UNSURE: n1, n2, ...\"',
      "   listing the question numbers you are especially unsure about.",
      "   - If you are reasonably confident about all of them, you may output an empty list like:",
      '     \"UNSURE:\" or \"UNSURE: -\".",
      "",
      "Examples of valid output format:",
      "1: B",
      "2: A",
      "3: C",
      "4: E",
      "5: D",
      "UNSURE: 3, 5",
      "",
      "Or:",
      "1: B",
      "2: A",
      "UNSURE: -",
      "",
      "Do NOT include any explanations. Do NOT include anything else."
    ].join("\n");

    const userPrompt = [
      `Page number: ${page}`,
      "",
      "These are the question numbers detected on this page:",
      numberListStr,
      "",
      "Here is the OCR text of the page:",
      "----- OCR TEXT BEGIN -----",
      text,
      "----- OCR TEXT END -----",
      "",
      "Remember:",
      "- Answer ONLY for the numbers in the list.",
      "- For every number in the list, you MUST output exactly one line 'N: X'.",
      "- Use 'n/a' only if you absolutely cannot infer the answer.",
      "- Finally, output 'UNSURE: ...' with the numbers you are least confident about."
    ].join("\n");

    let completion;
    try {
      completion = await callLLM({
        apiBase,
        apiKey,
        model,
        systemPrompt,
        userPrompt
      });
    } catch (e) {
      return json(200, {
        ok: false,
        error: "LLM request failed",
        detail: String(e && e.message ? e.message : e)
      });
    }

    const content =
      completion &&
      completion.choices &&
      completion.choices[0] &&
      completion.choices[0].message &&
      typeof completion.choices[0].message.content === "string"
        ? completion.choices[0].message.content.trim()
        : "";

    if (!content) {
      return json(200, {
        ok: false,
        error: "Empty completion from model",
        detail: completion || null
      });
    }

    // XURTH stop 토큰을 항상 서버에서 강제로 붙여주는 부분
    let finalText = content.trim();
    if (!finalText.includes(stopToken)) {
      finalText = finalText + "\n" + stopToken;
    }

    return json(200, {
      ok: true,
      text: finalText,
      debug: {
        page,
        rawNumbers,
        normalizedNumbers,
        numbersForPrompt,
        stopToken,
        model,
        rawCompletion: content
      }
    });
  } catch (e) {
    return json(200, {
      ok: false,
      error: String(e && e.message ? e.message : e)
    });
  }
};

// ---------- Helper: LLM 호출 ----------

async function callLLM({ apiBase, apiKey, model, systemPrompt, userPrompt }) {
  const url = apiBase.replace(/\/+$/, "") + "/chat/completions";

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    max_tokens: 512,
    temperature: 0.2
  };

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "HTTP-Referer":
      (process.env.SITE_URL || "").trim() ||
      "https://beamish-alpaca-e3df59.netlify.app",
    "X-Title": (process.env.LLM_TITLE || "").trim() || "answer-site-autonnonsul"
  };

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  let data;
  try {
    data = await resp.json();
  } catch (_) {
    data = null;
  }

  if (!resp.ok) {
    throw new Error(
      "LLM HTTP error: " +
        resp.status +
        " " +
        resp.statusText +
        " :: " +
        JSON.stringify(data)
    );
  }

  return data;
}

// ---------- Helper: 번호 추출 / 정리 ----------

function extractRawNumbers(text) {
  if (!text) return [];

  const raw = [];

  // 패턴 1: 줄 시작에 오는 번호 (예: "01 01.", "10. 10.", "7 07.")
  const linePattern = /^[^\S\r\n]*([0-9]{1,2})\s*[)\.]/gm;
  let m;
  while ((m = linePattern.exec(text)) !== null) {
    raw.push(m[1]);
  }

  // 패턴 2: 일반적인 "01." / "1." / "10)" 형태
  const inlinePattern = /\b([0-9]{1,2})\s*[)\.]/g;
  while ((m = inlinePattern.exec(text)) !== null) {
    raw.push(m[1]);
  }

  return raw;
}

function normalizeNumbers(rawNumbers) {
  const set = new Set();
  for (const r of rawNumbers || []) {
    const n = Number(String(r).replace(/^0+/, "")) || Number(r);
    if (Number.isFinite(n) && n >= 1 && n <= 50) {
      set.add(n);
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}

// OCR가 너무 깨져서 번호가 하나도 안 잡힌 경우를 위한 fallback
function inferFallbackNumbers(text) {
  if (!text) return [];

  const ranges = [];
  const rangePattern = /\[0?(\d+)\s*-\s*0?(\d+)\]/g;
  let m;
  while ((m = rangePattern.exec(text)) !== null) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
      for (let k = start; k <= end; k++) {
        if (k >= 1 && k <= 50) ranges.push(k);
      }
    }
  }

  const set = new Set(ranges);
  return Array.from(set).sort((a, b) => a - b);
}

// ---------- 공통 유틸 ----------

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

function safeJson(str) {
  try {
    return JSON.parse(str || "{}");
  } catch (_) {
    return {};
  }
}



