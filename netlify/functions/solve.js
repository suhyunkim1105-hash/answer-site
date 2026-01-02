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

/**
 * OCR 텍스트에서 문항 번호 추출 (1~50)
 *
 * - 형태 예시:
 *   "01." / "1." / "01 01." / "09.09." / "07 07." 등
 * - 전략:
 *   - "....11." 이면 마지막 점 앞의 숫자만 본다고 생각하고
 *   - 그냥 "(\d{1,2})\s*[\.\)]" 패턴으로 싹 긁어옴
 *   - 1~50 사이만 남기고, 중복 제거 후 오름차순 정렬
 */
function extractQuestionNumbers(text) {
  if (!text) return { rawNumbers: [], normalizedNumbers: [] };

  const rawNumbers = [];
  const re = /\b(\d{1,2})\s*[\.\)]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    rawNumbers.push(m[1]); // "1" ~ "12" 등
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

/**
 * ChatGPT용 메시지 구성
 * - 이번 버전에서는 무조건 A/B/C/D/E 중 하나를 찍게 하고
 *   n/a는 금지함 (너가 말한 “억지로라도 답 주기” 반영)
 */
function buildMessages(text, page, numbers, stopToken) {
  const nums = numbers.join(", ");

  const systemContent =
    "You are solving an English multiple-choice exam page.\n\n" +
    `- You will be given OCR text of ONE exam page and a list of question numbers on that page.\n` +
    `- The question numbers you MUST answer for this page are: ${nums}.\n` +
    "- For each question N, output exactly ONE line in the format: \"N: X\".\n" +
    "- X MUST be one of A, B, C, D, or E. You MUST NOT output \"n/a\" or leave any question unanswered.\n" +
    "- If the OCR is noisy and you are unsure, still choose the MOST LIKELY option, but mark that question number in the final UNSURE list.\n" +
    "- After answering ALL listed questions, add a final line starting with \"UNSURE:\" followed by a comma-separated list of question numbers you are NOT confident about. Use \"-\" if you are reasonably confident for all.\n" +
    `- Finally, on the VERY LAST line, output exactly the stop token ${stopToken}.\n` +
    "- Do NOT include any explanations, reasoning, or extra text.\n" +
    "- Do NOT invent any question numbers. ONLY answer for the numbers given in the list.\n" +
    "- Do NOT repeat the same option for ALL questions unless the OCR genuinely supports that.\n";

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

/**
 * OpenRouter 호출
 */
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

    // 기본: OCR에서 잡힌 번호 사용
    let numbersForPrompt = normalizedNumbers.slice();

    // 혹시 아무 번호도 못 잡았을 때만 백업으로 1~12 사용
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
