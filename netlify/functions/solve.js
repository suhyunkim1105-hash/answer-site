// netlify/functions/solve.js
// 매우 단순하고 안전한 버전 (문법 에러 방지용)

"use strict";

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const body = safeJson(event.body);
    const text = body && typeof body.text === "string" ? body.text.trim() : "";
    const page =
      body && Number.isFinite(Number(body.page)) ? Number(body.page) : 1;

    if (!text) {
      return json(400, { ok: false, error: "Missing text" });
    }

    // 1) OCR 텍스트에서 번호 추출
    const rawNumbers = extractRawNumbers(text);
    const normalizedNumbers = normalizeNumbers(rawNumbers);

    const stopToken = (process.env.STOP_TOKEN || "XURTH").trim() || "XURTH";

    // 2) LLM API 설정 (OpenRouter)
    const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
    if (!apiKey) {
      return json(500, { ok: false, error: "Missing OPENROUTER_API_KEY env var" });
    }

    const apiBase =
      (process.env.LLM_API_BASE || "").trim() ||
      "https://openrouter.ai/api/v1";

    const model =
      (process.env.LLM_MODEL || "").trim() ||
      "openai/gpt-4o-mini";

    // 번호가 하나도 안 잡힌 경우의 fallback
    const numbersForPrompt =
      normalizedNumbers.length > 0 ? normalizedNumbers : inferFallbackNumbers(text);

    const numberListStr =
      numbersForPrompt.length > 0 ? numbersForPrompt.join(", ") : "(none)";

    // 3) 프롬프트 구성 (영어, 설명 없음, 순수 포맷)
    const systemPrompt =
      "You solve English multiple choice questions from noisy OCR text.\n" +
      "You receive OCR text of ONE test page and a list of question numbers.\n" +
      "The OCR can be noisy.\n" +
      "Your job is to pick the best choice A/B/C/D/E for EACH number in the list.\n" +
      "Rules:\n" +
      "1) For every number in the list, output exactly ONE line: 'N: X'\n" +
      "   - N is the question number.\n" +
      "   - X is A, B, C, D, E, or 'n/a' if impossible.\n" +
      "2) Do NOT output answers for numbers that are NOT in the list.\n" +
      "3) At the end, output one more line 'UNSURE: n1, n2, ...' listing numbers you are least confident about.\n" +
      "4) If you are reasonably confident about all, output 'UNSURE: -'.\n" +
      "5) No explanations. No extra text. Only the lines in this format.";

    const userPrompt =
      "Page: " +
      String(page) +
      "\n\n" +
      "Detected question numbers on this page:\n" +
      numberListStr +
      "\n\nOCR TEXT BEGIN\n" +
      text +
      "\nOCR TEXT END\n\n" +
      "Remember: answer ONLY for the listed numbers, one line per number, then 'UNSURE: ...'.";

    // 4) LLM 호출
    let completion;
    try {
      completion = await callLLM({
        apiBase: apiBase,
        apiKey: apiKey,
        model: model,
        systemPrompt: systemPrompt,
        userPrompt: userPrompt
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

    // stop 토큰 강제 부착
    let finalText = content;
    if (finalText.indexOf(stopToken) === -1) {
      finalText = finalText + "\n" + stopToken;
    }

    return json(200, {
      ok: true,
      text: finalText,
      debug: {
        page: page,
        rawNumbers: rawNumbers,
        normalizedNumbers: normalizedNumbers,
        numbersForPrompt: numbersForPrompt,
        stopToken: stopToken,
        model: model,
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

// ------------- LLM 호출 -------------

async function callLLM(args) {
  const apiBase = args.apiBase;
  const apiKey = args.apiKey;
  const model = args.model;
  const systemPrompt = args.systemPrompt;
  const userPrompt = args.userPrompt;

  const url = apiBase.replace(/\/+$/, "") + "/chat/completions";

  const body = {
    model: model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    max_tokens: 512,
    temperature: 0.2
  };

  const headers = {
    "content-type": "application/json",
    authorization: "Bearer " + apiKey,
    "HTTP-Referer":
      (process.env.SITE_URL || "").trim() ||
      "https://beamish-alpaca-e3df59.netlify.app",
    "X-Title":
      (process.env.LLM_TITLE || "").trim() || "answer-site-autonnonsul"
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(body)
  });

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    data = null;
  }

  if (!resp.ok) {
    throw new Error(
      "LLM HTTP error " +
        resp.status +
        " " +
        resp.statusText +
        " :: " +
        JSON.stringify(data)
    );
  }

  return data;
}

// ------------- 번호 추출 -------------

function extractRawNumbers(text) {
  if (!text) return [];
  const result = [];

  // 줄 시작 쪽 번호
  const linePattern = /^[^\S\r\n]*([0-9]{1,2})\s*[)\.]/gm;
  let m;
  while ((m = linePattern.exec(text)) !== null) {
    result.push(m[1]);
  }

  // 인라인 번호
  const inlinePattern = /\b([0-9]{1,2})\s*[)\.]/g;
  while ((m = inlinePattern.exec(text)) !== null) {
    result.push(m[1]);
  }

  return result;
}

function normalizeNumbers(rawNumbers) {
  const set = new Set();
  for (let i = 0; i < rawNumbers.length; i++) {
    const r = String(rawNumbers[i] || "");
    const cleaned = r.replace(/^0+/, "");
    const n = Number(cleaned);
    if (Number.isFinite(n) && n >= 1 && n <= 50) {
      set.add(n);
    }
  }
  return Array.from(set).sort(function (a, b) {
    return a - b;
  });
}

// [11-20] 같은 범위에서 추론용 fallback
function inferFallbackNumbers(text) {
  if (!text) return [];
  const arr = [];
  const rangePattern = /\[0?(\d+)\s*-\s*0?(\d+)\]/g;
  let m;
  while ((m = rangePattern.exec(text)) !== null) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
      for (let k = start; k <= end; k++) {
        if (k >= 1 && k <= 50) arr.push(k);
      }
    }
  }
  const set = new Set(arr);
  return Array.from(set).sort(function (a, b) {
    return a - b;
  });
}

// ------------- 공통 유틸 -------------

function json(statusCode, obj) {
  return {
    statusCode: statusCode,
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
  } catch (e) {
    return {};
  }
}

