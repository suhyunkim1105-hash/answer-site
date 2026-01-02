// netlify/functions/solve.js

"use strict";

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

function safeJson(str) {
  try {
    return JSON.parse(str || "{}");
  } catch (_) {
    return {};
  }
}

// OCR 텍스트에서 문항 번호 추출 (1~50)
function extractQuestionNumbers(text) {
  if (!text) return { rawNumbers: [], normalizedNumbers: [] };

  const rawNumbers = [];
  // 예: "01 01.", "03.", "10.", "09.09." 등에서 번호 뽑기
  const re = /\b(0?[1-9]|[1-4][0-9]|50)\s*[\.\)]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    rawNumbers.push(m[1]);
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

// 모델 출력 파싱: "1: B" 형식과 "UNSURE: 3, 4" 추출
function parseModelOutput(completion, questionNumbers) {
  const answers = {};
  const unsure = new Set();

  const lines = String(completion || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const answerRe = /^(\d+)\s*:\s*([A-E])/i;
  const unsureRe = /^UNSURE\s*:\s*(.*)$/i;

  for (const line of lines) {
    const mAns = line.match(answerRe);
    if (mAns) {
      const qNum = parseInt(mAns[1], 10);
      const opt = mAns[2].toUpperCase();
      if (questionNumbers.includes(qNum)) {
        answers[qNum] = opt;
      }
      continue;
    }

    const mUnsure = line.match(unsureRe);
    if (mUnsure) {
      const payload = mUnsure[1].trim();
      if (payload && payload !== "-") {
        for (const token of payload.split(/[,\s]+/)) {
          const n = parseInt(token, 10);
          if (Number.isFinite(n) && questionNumbers.includes(n)) {
            unsure.add(n);
          }
        }
      }
    }
  }

  // 어떤 번호든 A~E 하나는 반드시 갖도록 보정
  for (const q of questionNumbers) {
    if (!answers[q]) {
      // 모델이 안 준 경우: "?" 넣고 UNSURE에 추가
      answers[q] = "?";
      unsure.add(q);
    }
  }

  const orderedAnswersText = questionNumbers
    .map((q) => `${q}: ${answers[q]}`)
    .join("\n");

  const unsureList = questionNumbers.filter((q) => unsure.has(q));
  const unsureText = unsureList.length ? unsureList.join(", ") : "-";

  return { answersText: orderedAnswersText, unsureText };
}

// Netlify 함수 엔트리
exports.handler = async function (event /*, context */) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const body = safeJson(event.body);
    const text = (body && typeof body.text === "string" ? body.text : "").trim();
    const page = body && typeof body.page === "number" ? body.page : null;

    if (!text) {
      return json(400, { ok: false, error: "Missing text" });
    }

    // 1. 문항 번호 추출
    const { rawNumbers, normalizedNumbers } = extractQuestionNumbers(text);
    if (!normalizedNumbers.length) {
      return json(200, {
        ok: false,
        error: "No question numbers detected in text",
        debug: {
          page,
          rawNumbers,
          normalizedNumbers
        }
      });
    }

    // 현재 페이지에서 답을 구할 문항 번호 리스트
    const numbersForPrompt = normalizedNumbers.slice(); // 그대로 사용 (1~12 등)

    const stopToken = (process.env.STOP_TOKEN || "XURTH").trim() || "XURTH";
    const model =
      (process.env.CHAT_MODEL || "").trim() || "openai/gpt-4o-mini";

    const baseUrl =
      (process.env.OPENROUTER_BASE_URL || "").trim() ||
      "https://openrouter.ai/api/v1/chat/completions";
    const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();

    if (!apiKey) {
      return json(500, {
        ok: false,
        error: "Missing OPENROUTER_API_KEY env var"
      });
    }

    const questionListStr = numbersForPrompt.join(", ");

    const systemPrompt = [
      "You are an assistant that solves English multiple-choice exam questions from OCR'd test pages.",
      "Each question has exactly one correct answer among A, B, C, D, E.",
      "You must follow the required output format exactly."
    ].join(" ");

    const userPrompt = [
      `The following is the OCR text of one exam page. The page contains questions with these numbers: ${questionListStr}.`,
      "",
      "Rules:",
      "- For EVERY question number in the list, you MUST output exactly one answer choice from A, B, C, D, or E.",
      "- You are NOT allowed to answer with 'n/a', 'unknown', 'skip', or leave any question without an A–E choice.",
      "- Even if the OCR is noisy or you are not fully certain, always guess the most likely option among A–E.",
      "- After answering all questions, add one line starting with 'UNSURE:' listing the question numbers you are least confident about.",
      "- If you are reasonably confident about all, write 'UNSURE: -'.",
      "",
      "Output format (and nothing else):",
      "1: B",
      "2: A",
      "...",
      `${numbersForPrompt[numbersForPrompt.length - 1]}: D`,
      "UNSURE: (comma-separated question numbers, or '-' if none)",
      "",
      "<PAGE>",
      text,
      "</PAGE>"
    ].join("\n");

    const payload = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 256
    };

    const timeoutMs = Number(process.env.CHAT_TIMEOUT_MS || 23000);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    let resp;
    try {
      resp = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(t);
      return json(200, {
        ok: false,
        error: "Chat API fetch failed",
        detail: String(e && e.message ? e.message : e)
      });
    }
    clearTimeout(t);

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      return json(200, {
        ok: false,
        error: "Chat API JSON parse failed",
        detail: String(e && e.message ? e.message : e)
      });
    }

    if (!resp.ok) {
      return json(200, {
        ok: false,
        error: "Chat API HTTP error",
        detail: data
      });
    }

    const choice =
      data &&
      Array.isArray(data.choices) &&
      data.choices.length > 0 &&
      data.choices[0];

    const completion =
      choice &&
      choice.message &&
      typeof choice.message.content === "string"
        ? choice.message.content.trim()
        : "";

    if (!completion) {
      return json(200, {
        ok: false,
        error: "Empty completion from model",
        detail: data
      });
    }

    const parsed = parseModelOutput(completion, numbersForPrompt);

    const finalText =
      parsed.answersText + "\nUNSURE: " + parsed.unsureText + "\n" + stopToken;

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
        rawCompletion: completion
      }
    });
  } catch (e) {
    return json(200, {
      ok: false,
      error: "solve.js unhandled error",
      detail: String(e && e.message ? e.message : e)
    });
  }
};

