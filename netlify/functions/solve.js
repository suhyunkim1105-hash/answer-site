// netlify/functions/solve.js

// 공통 JSON 응답 헬퍼
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

// 안전한 JSON 파서
function safeJson(str) {
  try {
    return JSON.parse(str || "{}");
  } catch (_) {
    return {};
  }
}

// OCR 텍스트에서 문항 번호 추출 (1~50)
// 01. / 1. / 01 01. / 0101. / 07 07. / 0707. 모두 대응
function extractQuestionNumbers(text) {
  if (!text) return { rawNumbers: [], normalizedNumbers: [] };

  const rawNumbers = [];
  // (예)
  //  - "01."      → 1
  //  - "1."       → 1
  //  - "0101."    → 1 (앞의 01만 사용)
  //  - "07 07."   → 7
  //  - "0707."    → 7
  const re = /\b(0?[1-9]|[1-4][0-9]|50)\s*(?:\1)?\s*[\.\)]/g;

  let m;
  while ((m = re.exec(text)) !== null) {
    rawNumbers.push(m[1]); // 그룹 1 (01, 05, 07 등)만 사용
  }

  const normalizedNumbers = Array.from(
    new Set(
      rawNumbers
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 50)
    )
  ).sort((a, b) => a - b);

  return { rawNumbers, normalizedNumbers };
}

// ChatGPT 프롬프트 구성
function buildMessages(text, page, numbers, stopToken) {
  const nums = numbers.join(", ");

  const systemContent =
    "You are solving an English multiple-choice exam page.\n\n" +
    `- You will be given OCR text of one exam page and a list of question numbers on that page.\n` +
    `- The question numbers you MUST answer for this page are: ${nums}.\n` +
    "- DO NOT invent any other question numbers.\n" +
    "- For each question N, output exactly one line in the format: \"N: X\" where X is one of A, B, C, D, E, or \"n/a\" if the question text or choices are too garbled.\n" +
    "- After answering, add a final line starting with \"UNSURE:\" followed by a comma-separated list of question numbers for which you are not confident because of OCR noise. Use \"-\" if you are reasonably confident for all.\n" +
    `- Finally, on the VERY LAST line, output exactly the stop token ${stopToken}.\n` +
    "- Do NOT include explanations.\n" +
    "- Follow this exact output format. No extra text.";

  const userContent =
    `Page: ${page}\n` +
    `Question numbers on this page: ${nums}\n\n` +
    "OCR TEXT (may contain artifacts like @, weird spacing, and minor spelling errors):\n\n" +
    text;

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent }
  ];
}

// OpenRouter 호출
async function callModelAndRespond(ctx) {
  const {
    text,
    page,
    numbersForPrompt,
    rawNumbers,
    normalizedNumbers,
    stopToken
  } = ctx;

  const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) {
    return json(500, {
      ok: false,
      error: "Missing OPENROUTER_API_KEY env var"
    });
  }

  const model =
    (process.env.OPENROUTER_MODEL || "").trim() || "openai/gpt-4o-mini";

  const baseUrl =
    (process.env.OPENROUTER_URL || "").trim() ||
    "https://openrouter.ai/api/v1/chat/completions";

  const messages = buildMessages(text, page, numbersForPrompt, stopToken);

  const payload = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 256
  };

  let resp;
  try {
    resp = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "autononsul-solver"
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return json(200, {
      ok: false,
      error: "Model fetch failed",
      detail: String(e && e.message ? e.message : e)
    });
  }

  let data;
  try {
    data = await resp.json();
  } catch (_) {
    data = {};
  }

  if (!resp.ok) {
    return json(200, {
      ok: false,
      error: "Model HTTP error",
      detail: data
    });
  }

  const choice =
    data &&
    Array.isArray(data.choices) &&
    data.choices.length > 0 &&
    data.choices[0];

  const content =
    choice &&
    choice.message &&
    typeof choice.message.content === "string"
      ? choice.message.content.trim()
      : "";

  const finishReason =
    choice && (choice.finish_reason || choice.native_finish_reason);

  if (!content) {
    return json(200, {
      ok: false,
      error: "Empty completion from model",
      detail: data
    });
  }

  return json(200, {
    ok: true,
    text: content,
    debug: {
      page,
      rawNumbers,
      normalizedNumbers,
      numbersForPrompt,
      stopToken,
      model,
      finishReason,
      rawCompletion: content
    }
  });
}

// Netlify 함수 엔트리
exports.handler = async function (event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const body = safeJson(event.body);
    const text =
      body && typeof body.text === "string" ? body.text.trim() : "";
    const page =
      body && typeof body.page === "number" ? body.page : 1;

    if (!text) {
      return json(400, { ok: false, error: "Missing text" });
    }

    const stopToken =
      (process.env.STOP_TOKEN || "XURTH").trim() || "XURTH";

    const { rawNumbers, normalizedNumbers } = extractQuestionNumbers(text);

    // 기본: 추출된 번호 그대로 사용
    let numbersForPrompt = normalizedNumbers.slice();

    // 번호 하나도 못 잡으면(정규식/레이아웃 이상) 백업으로 1~12 시도
    if (!numbersForPrompt.length) {
      const fallback = [];
      for (let i = 1; i <= 12; i++) fallback.push(i);
      numbersForPrompt = fallback;
    }

    return await callModelAndRespond({
      text,
      page,
      numbersForPrompt,
      rawNumbers,
      normalizedNumbers,
      stopToken
    });
  } catch (e) {
    return json(200, {
      ok: false,
      error: String(e && e.message ? e.message : e)
    });
  }
};


