// netlify/functions/solve.js

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

// "1: A" 이런 형식의 텍스트에서 번호/선지를 파싱
function parseAnswersFromText(text) {
  const answers = {};
  const questionNumbers = [];
  const letterToIndex = { A: 1, B: 2, C: 3, D: 4, E: 5 };

  if (!text || typeof text !== "string") {
    return { questionNumbers, answers, unsure: [] };
  }

  const lineRegex = /(\d{1,2})\s*[:.\-]\s*([A-E])/gi;
  let m;
  while ((m = lineRegex.exec(text)) !== null) {
    const q = parseInt(m[1], 10);
    const letter = m[2].toUpperCase();
    if (!Number.isNaN(q) && letterToIndex[letter]) {
      answers[q] = letterToIndex[letter];
      if (!questionNumbers.includes(q)) {
        questionNumbers.push(q);
      }
    }
  }
  questionNumbers.sort((a, b) => a - b);

  const unsure = [];
  const unsureMatch = text.match(/UNSURE\s*:\s*([0-9,\s\-]+)/i);
  if (unsureMatch && unsureMatch[1]) {
    unsureMatch[1]
      .split(/[,]/)
      .map((v) => v.trim())
      .forEach((token) => {
        if (!token) return;
        if (token.includes("-")) {
          const [startStr, endStr] = token.split("-").map((x) => x.trim());
          const start = parseInt(startStr, 10);
          const end = parseInt(endStr, 10);
          if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
            for (let q = start; q <= end; q++) unsure.push(q);
          }
        } else {
          const q = parseInt(token, 10);
          if (!Number.isNaN(q)) unsure.push(q);
        }
      });
  }

  return { questionNumbers, answers, unsure };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, { ok: false, error: "OPENROUTER_API_KEY is not set" });
    }

    const model = process.env.MODEL_NAME || "openai/gpt-5.1";
    const stopToken = process.env.STOP_TOKEN || "XURTH";
    const temperatureRaw =
      typeof process.env.TEMPERATURE === "string"
        ? Number(process.env.TEMPERATURE)
        : 0.1;
    const temperature =
      Number.isFinite(temperatureRaw) && temperatureRaw >= 0 && temperatureRaw <= 1
        ? temperatureRaw
        : 0.1;

    const maxTokensRaw =
      typeof process.env.MAX_TOKENS === "string"
        ? Number(process.env.MAX_TOKENS)
        : NaN;
    const max_tokens =
      Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 && maxTokensRaw <= 4096
        ? maxTokensRaw
        : 512; // ★ 토큰 상한 강제 (크레딧/length 문제 방지)

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const ocrText = String(body.ocrText || body.text || "").trim();

    if (!ocrText) {
      return json(400, { ok: false, error: "Missing ocrText" });
    }

    // 프롬프트: 1: A 형식 + 마지막 줄 UNSURE: ... 형식 요구
    const systemPrompt = [
      "너는 한국 편입 영어 객관식 시험 채점관이다.",
      "입력으로 영어 지문(OCR 텍스트) 전체가 주어진다.",
      "해야 할 일:",
      "- 보이는 모든 객관식 문항의 정답을 골라라.",
      "- 각 문항에 대해 보기(A~E 또는 A~D) 중 하나만 선택한다.",
      "- 정보가 애매해도 반드시 하나를 골라야 한다.",
      "",
      "출력 형식 (반드시 지켜라):",
      "- 각 줄에 '번호: 선지' 형식으로 쓴다. 예: '1: A', '2: D'",
      "- 번호는 정수, 콜론(:) 뒤에 공백 하나, 그 다음 A~E 중 하나",
      "- 마지막 줄에는 'UNSURE: x, y, z' 형식으로 정보가 부족하거나 자신 없는 문항 번호를 쉼표로 나열한다.",
      "  예: 'UNSURE: 3, 8, 9' 혹은 애매한 게 없으면 'UNSURE: -'",
      "",
      "중요:",
      "- 절대 해설, 설명, 한국어 문장, 기타 텍스트를 쓰지 마라.",
      "- 오직 위에서 정의한 형식만 출력해라.",
      "- 출력 마지막에는 '" + stopToken + "' 토큰을 덧붙여라."
    ].join("\n");

    const userPrompt = [
      "다음은 편입 영어 객관식 시험지의 OCR 텍스트다.",
      "보이는 문항에 대해 위 규칙에 따라 정답을 골라라.",
      "",
      "----- OCR TEXT (PAGE " + page + ") -----",
      ocrText,
      "---------------------------------------"
    ].join("\n");

    let res;
    let raw;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens,
          stop: [stopToken],
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      const status = res.status;
      raw = await res.text();

      if (!res.ok) {
        // OpenRouter 에러 원문 그대로 노출
        return json(502, {
          ok: false,
          error: "OpenRouter error",
          status,
          raw: raw.slice(0, 2000),
        });
      }
    } catch (e) {
      return json(502, {
        ok: false,
        error: "Fetch to OpenRouter failed",
        detail: String(e && e.message ? e.message : e),
      });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return json(502, {
        ok: false,
        error: "Invalid JSON from OpenRouter",
        raw: raw.slice(0, 2000),
      });
    }

    const choice = data.choices && data.choices[0];
    const answerText =
      choice &&
      choice.message &&
      typeof choice.message.content === "string"
        ? choice.message.content.replace(stopToken, "").trim()
        : "";

    if (!answerText) {
      return json(502, {
        ok: false,
        error: "Empty answer from model",
        dataPreview: JSON.stringify(data).slice(0, 1000),
      });
    }

    const { questionNumbers, answers, unsure } = parseAnswersFromText(answerText);

    const debug = {
      page,
      model: data.model || model,
      questionNumbers,
      answers,
      unsure,
      finishReason: choice && choice.finish_reason ? choice.finish_reason : null,
      ocrTextPreview: ocrText.slice(0, 280),
    };

    return json(200, {
      ok: true,
      text: answerText,
      debug,
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "Unexpected solve error",
      detail: String(e && e.message ? e.message : e),
    });
  }
};

