// netlify/functions/solve.js
// OCR로 인식한 성대 편입 영어 시험지를 OpenRouter에 보내서
// 문항별 정답(A~E)만 반환하는 함수.
//
// 기대 입력(JSON):
// { "text": "<OCR 결과 문자열>", "page": 1 }
//
// 반환(JSON):
// {
//   ok: true/false,
//   text: "1: B\n2: C\n...\nUNSURE: 2, 3",
//   debug: { ... }
// }

const DEFAULT_MODEL = process.env.MODEL_NAME || "openai/gpt-5.2";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const STOP_TOKEN = process.env.STOP_TOKEN || "XURTH";
const TEMPERATURE = process.env.TEMPERATURE
  ? Number(process.env.TEMPERATURE)
  : 0.1;

const LETTER_TO_INDEX = { A: 1, B: 2, C: 3, D: 4, E: 5 };

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
    },
    body: JSON.stringify(obj),
  };
}

// OCR 텍스트에서 실제 "문항 번호"만 뽑는다.
// 규칙: 줄 맨 앞에서 시작하는 1~2자리 숫자(앞에 0 가능) + 공백/점/괄호.
function detectQuestionNumbers(ocrText) {
  const nums = new Set();
  const lineRegex = /^0?(\d{1,2})[). ]/gm;
  let m;
  while ((m = lineRegex.exec(ocrText)) !== null) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 50) nums.add(n);
  }
  // 정렬된 배열로 반환
  return Array.from(nums).sort((a, b) => a - b);
}

// 모델 출력에서 "번호: 선택지"를 파싱해서
// { [문항번호]: 'A'~'E' } 형태로 만든다.
function parseAnswersFromCompletion(completionText, questionNumbers) {
  const answers = {};
  const seen = new Set();

  // 패턴 예: "1: A", "20 - C"
  const pairRegex = /(\d{1,2})\s*[:\-]\s*([A-E])/gi;
  let m;
  while ((m = pairRegex.exec(completionText)) !== null) {
    const q = Number(m[1]);
    const letter = m[2].toUpperCase();
    if (!LETTER_TO_INDEX[letter]) continue;
    if (!questionNumbers.includes(q)) continue;
    if (seen.has(q)) continue;
    answers[q] = letter;
    seen.add(q);
  }

  // 모델이 안 준 번호는 전부 A로 채우고 UNSURE에 넣는다.
  const unsure = [];
  for (const q of questionNumbers) {
    if (!answers[q]) {
      answers[q] = "A";
      unsure.push(q);
    }
  }

  return { answers, unsure };
}

function buildPrompt(ocrText, questionNumbers) {
  const numsStr = questionNumbers.join(", ");
  return [
    "You are solving a Korean university transfer English multiple-choice exam.",
    "Each question has exactly one correct option among A, B, C, D, and E.",
    "",
    "You are given OCR text that may contain multiple questions.",
    `You MUST answer ALL of the following question numbers: ${numsStr}.`,
    "",
    "Rules:",
    "- For EVERY listed question number, you MUST output exactly ONE choice letter (A, B, C, D, or E).",
    "- Even if the OCR text for a question is incomplete or confusing, you still MUST guess an answer.",
    "- Do NOT skip any question number. No blanks are allowed.",
    "",
    "Output format (VERY IMPORTANT):",
    "1: A",
    "2: B",
    "3: C",
    "...",
    "UNSURE: 2, 3",
    "",
    "- The 'UNSURE' line should list question numbers where the OCR was clearly incomplete and you had to guess.",
    "- If you are reasonably confident in all answers, output 'UNSURE: -'.",
    "",
    `After the UN SURE line, end your answer with the token ${STOP_TOKEN} on its own line.`,
    "",
    "OCR_TEXT:",
    ocrText,
  ].join("\n");
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return json(200, { ok: true });
    }

    if (!OPENROUTER_API_KEY) {
      return json(500, {
        ok: false,
        error: "OPENROUTER_API_KEY is not set",
      });
    }

    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const text = (payload.text || "").toString();
    const page = Number(payload.page || 1);

    if (!text.trim()) {
      return json(400, { ok: false, error: "Empty OCR text" });
    }

    const questionNumbers = detectQuestionNumbers(text);

    if (!questionNumbers.length) {
      // 문항 번호를 하나도 못 찾은 경우: 프롬프트만 보내서 1번부터 50번까지 찍어내게 할 수도 있지만,
      // 지금은 확실히 에러로 돌려서 다시 촬영하게 한다.
      return json(400, {
        ok: false,
        error: "No question numbers found in OCR text",
      });
    }

    const prompt = buildPrompt(text, questionNumbers);

    const body = {
      model: DEFAULT_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are an accurate multiple-choice exam solver. Follow the requested output format exactly.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: TEMPERATURE,
      max_tokens: 512,
      stop: [STOP_TOKEN],
    };

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return json(response.status, {
        ok: false,
        error: "OpenRouter API error",
        detail: errText,
      });
    }

    const data = await response.json();
    const choice = data.choices && data.choices[0];
    const content = choice && choice.message && choice.message.content;

    if (!content) {
      return json(500, {
        ok: false,
        error: "No completion from model",
        raw: data,
      });
    }

    const { answers, unsure } = parseAnswersFromCompletion(
      content,
      questionNumbers
    );

    // text 필드: "1: B\n2: C\n...\nUNSURE: 2, 3" 형식
    const lines = [];
    for (const q of questionNumbers) {
      const letter = answers[q] || "A";
      lines.push(`${q}: ${letter}`);
    }
    lines.push(`UNSURE: ${unsure.length ? unsure.join(", ") : "-"}`);

    const debugAnswers = {};
    for (const [qStr, letter] of Object.entries(answers)) {
      const idx = LETTER_TO_INDEX[letter] || 1;
      debugAnswers[qStr] = idx;
    }

    return json(200, {
      ok: true,
      text: lines.join("\n"),
      debug: {
        page,
        model: DEFAULT_MODEL,
        questionNumbers,
        answers: debugAnswers,
        unsure,
        finishReason: choice.finish_reason || null,
        ocrTextPreview: text.slice(0, 400),
      },
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "Unexpected server error",
      detail: err && err.message ? err.message : String(err),
    });
  }
};
