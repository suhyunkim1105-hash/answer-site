// netlify/functions/solve.js
// OpenRouter를 호출해서 객관식 정답만 뽑아주는 함수.
// - env: OPENROUTER_API_KEY (필수)
// - env: MODEL_NAME (예: openai/gpt-5.2)
// - env: STOP_TOKEN (예: XURTH, optional – stop 시퀀스로 사용)
// - env: TEMPERATURE (예: 0.1, optional)

const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME || "openai/gpt-5.2";
const STOP_TOKEN = process.env.STOP_TOKEN || "XURTH";
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.1");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(obj)
  };
}

// A~E → 1~5
const LETTER_TO_INDEX = { A: 1, B: 2, C: 3, D: 4, E: 5 };
const INDEX_TO_LETTER = { 1: "A", 2: "B", 3: "C", 4: "D", 5: "E" };

// 모델이 죽거나 JSON 파싱이 안 되는 경우에도
// 무조건 모든 문항에 대해 답을 찍어서 돌려주는 fallback.
function fallbackGuess(ocrText, questionNumbers, page, reason) {
  const answersLetters = {};
  const unsure = [];
  const letters = ["A", "B", "C", "D", "E"];

  for (let i = 0; i < questionNumbers.length; i++) {
    const q = questionNumbers[i];
    // 완전 랜덤보다, 질문 번호 기반으로 결정해서 항상 동일하게.
    const letter = letters[q % letters.length];
    answersLetters[q] = letter;
    unsure.push(q);
  }

  const lines = questionNumbers.map((q) => `${q}: ${answersLetters[q]}`);
  if (unsure.length > 0) {
    lines.push(`UNSURE: ${unsure.join(", ")}`);
  }

  const answersIndex = {};
  for (const q of questionNumbers) {
    const letter = answersLetters[q];
    answersIndex[q] = LETTER_TO_INDEX[letter] || 1;
  }

  return json(200, {
    ok: true,
    text: lines.join("\n"),
    answers: answersIndex,
    unsure,
    debug: {
      page,
      model: MODEL_NAME,
      reason,
      questionNumbers,
      ocrTextPreview: (ocrText || "").slice(0, 200)
    }
  });
}

// 모델 응답에서 JSON만 뽑아서 파싱
function safeParseJsonFromText(content) {
  if (!content || typeof content !== "string") return null;
  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  const slice = content.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod && event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    // ------ 요청 파싱 ------
    let body = {};
    try {
      if (typeof event.body === "string") {
        body = JSON.parse(event.body || "{}");
      } else if (event.body && typeof event.body === "object") {
        body = event.body;
      }
    } catch {
      body = {};
    }

    // OCR 텍스트: text / ocrText / ocr / content 중 뭐가 오든 다 받아줌
    const ocrTextRaw =
      body.text ??
      body.ocrText ??
      body.ocr ??
      body.content ??
      "";

    const ocrText = String(ocrTextRaw || "");

    // 페이지 번호 (디버그용)
    const page = Number(body.page || 1);

    // questionNumbers 배열 (예: [1,2,3,4,5])
    let questionNumbers = [];
    if (Array.isArray(body.questionNumbers)) {
      questionNumbers = body.questionNumbers;
    } else if (Array.isArray(body.questions)) {
      questionNumbers = body.questions;
    }

    // number로 정리
    questionNumbers = questionNumbers
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isFinite(n));

    // 혹시라도 비어 있으면 안전하게 1~5 기본값 (절대 비우지 않기)
    if (questionNumbers.length === 0) {
      questionNumbers = [1, 2, 3, 4, 5];
    }

    // 🔴 여기서 예전 코드처럼 "Empty OCR text" 로 에러 주던 체크는 **삭제**.
    // OCR가 비어 있어도, 모델에게 그대로 보내서 어떻게든 찍게 만들거나,
    // 최악의 경우 fallbackGuess로 찍어서라도 답을 돌려준다.

    // ------ OpenRouter 호출 준비 ------
    if (!API_KEY) {
      // 키 없으면 바로 fallback
      return fallbackGuess(
        ocrText,
        questionNumbers,
        page,
        "Missing OPENROUTER_API_KEY"
      );
    }

    const systemPrompt =
      "You are an answer-key generator for an English multiple-choice exam.\n" +
      "For each question number, choose exactly ONE option from A, B, C, D, E.\n" +
      "You MUST answer ALL questions in the list.\n" +
      "If the OCR text is incomplete or unclear, make your best educated guess.\n" +
      "Mark such low-confidence questions in an 'unsure' list.\n" +
      'Respond ONLY with valid JSON like:\n' +
      '{\n' +
      '  "answers": {"1": "B", "2": "E"},\n' +
      '  "unsure": [2]\n' +
      "}";

    const userPrompt =
      "OCR_TEXT:\n" +
      ocrText +
      "\n\n" +
      "QUESTION_NUMBERS: " +
      questionNumbers.join(", ") +
      "\n\n" +
      'Return JSON now with keys "answers" and "unsure". ' +
      'Do NOT include any extra commentary or formatting.';

    const bodyForApi = {
      model: MODEL_NAME,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: isNaN(TEMPERATURE) ? 0.1 : TEMPERATURE,
      max_tokens: 512
    };

    if (STOP_TOKEN) {
      bodyForApi.stop = [STOP_TOKEN];
    }

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        // 이 두 헤더는 OpenRouter 권장(없어도 동작은 하지만 넣어두는 게 좋음)
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site-solve"
      },
      body: JSON.stringify(bodyForApi)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return fallbackGuess(
        ocrText,
        questionNumbers,
        page,
        `OpenRouter HTTP ${resp.status}: ${text.slice(0, 200)}`
      );
    }

    const data = await resp.json().catch(() => null);
    const choice = data && data.choices && data.choices[0];
    const content =
      choice && choice.message && typeof choice.message.content === "string"
        ? choice.message.content
        : "";

    let parsed = safeParseJsonFromText(content);
    if (!parsed || typeof parsed !== "object") {
      return fallbackGuess(
        ocrText,
        questionNumbers,
        page,
        "Model JSON parse failed"
      );
    }

    const answersObj = parsed.answers || {};
    const unsureListRaw = Array.isArray(parsed.unsure) ? parsed.unsure : [];

    const answersLetters = {};
    const answersIndex = {};
    const unsureSet = new Set();

    // unsure 배열을 숫자 집합으로 정리
    for (const u of unsureListRaw) {
      const num = parseInt(u, 10);
      if (Number.isFinite(num)) unsureSet.add(num);
    }

    // 각 문항별로 최종 답 결정
    for (const q of questionNumbers) {
      let letter =
        answersObj[String(q)] ||
        answersObj[Number(q)] ||
        answersObj[q] ||
        "";

      if (typeof letter === "number") {
        letter = INDEX_TO_LETTER[letter] || "";
      } else if (typeof letter === "string") {
        letter = letter.trim().toUpperCase();
      }

      if (!["A", "B", "C", "D", "E"].includes(letter)) {
        // 모델이 이상하게 답하면 기본값으로 A를 넣고 unsure에 포함
        letter = "A";
        unsureSet.add(q);
      }

      answersLetters[q] = letter;
      answersIndex[q] = LETTER_TO_INDEX[letter] || 1;
    }

    const lines = questionNumbers.map((q) => `${q}: ${answersLetters[q]}`);
    const unsureArr = Array.from(unsureSet).sort((a, b) => a - b);
    if (unsureArr.length > 0) {
      lines.push(`UNSURE: ${unsureArr.join(", ")}`);
    }

    return json(200, {
      ok: true,
      text: lines.join("\n"),
      answers: answersIndex,
      unsure: unsureArr,
      debug: {
        page,
        model: MODEL_NAME,
        questionNumbers,
        finishReason: choice && choice.finish_reason,
        ocrTextPreview: ocrText.slice(0, 200),
        rawModelContent: content.slice(0, 200)
      }
    });
  } catch (err) {
    return fallbackGuess(
      "",
      [1, 2, 3, 4, 5],
      1,
      "Top-level error: " + String(err && err.message ? err.message : err)
    );
  }
};
