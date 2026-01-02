// netlify/functions/solve.js
// 성균관대 모든 기출 페이지에서 동작하도록 만든 solve 함수

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// 안전 JSON 파서
function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// 텍스트 전체에서 "01." / "7)" 같은 패턴으로 문항 번호 추출
// - 1~50 사이 숫자만 사용
// - 바로 앞 문자가 숫자면(0101. 같은 경우) 스킵
function extractQuestionNumbers(ocrText) {
  const pattern = /(\d{1,2})\s*[.)]/g;
  const found = new Set();
  let m;

  while ((m = pattern.exec(ocrText)) !== null) {
    const num = parseInt(m[1], 10);
    const index = m.index;
    const prevChar = index > 0 ? ocrText[index - 1] : " ";

    // 바로 앞이 숫자면 (ex. "0101.") 문항 번호로 보지 않음
    if (/\d/.test(prevChar)) continue;
    if (!Number.isInteger(num) || num < 1 || num > 50) continue;

    found.add(num);
  }

  return Array.from(found).sort((a, b) => a - b);
}

// [06-10] ... ungrammatical / unacceptable / grammatical
// 처럼 "문법" 지시문이 들어간 범위를 찾아서 그 범위 번호를 문법 문항으로 처리
function detectGrammarNumbers(ocrText, questionNumbers) {
  const rangePattern =
    /\[(\d{1,2})\s*-\s*(\d{1,2})\][\s\S]{0,200}?(ungrammatical|unacceptable|grammatical)/gi;

  const qSet = new Set(questionNumbers);
  const grammarSet = new Set();
  let m;

  while ((m = rangePattern.exec(ocrText)) !== null) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;

    for (let n = start; n <= end; n++) {
      if (qSet.has(n)) {
        grammarSet.add(n);
      }
    }
  }

  return Array.from(grammarSet).sort((a, b) => a - b);
}

// OpenRouter에 줄 프롬프트 만들기
function buildPrompt(ocrText, questionNumbers, grammarNumbers) {
  const grammarSet = new Set(grammarNumbers);
  const mcNumbers = questionNumbers.filter((n) => !grammarSet.has(n));

  const allList = questionNumbers.join(", ");
  const mcList = mcNumbers.length ? mcNumbers.join(", ") : "-";
  const grList = grammarNumbers.length ? grammarNumbers.join(", ") : "-";

  const linesSpec = questionNumbers
    .map((n) => `${n}: <answer>`)
    .join("\n");

  return (
    `You are solving an English multiple-choice entrance exam from Sungkyunkwan University.\n` +
    `You are given OCR text from ONE page of the test.\n\n` +
    `OCR TEXT START\n` +
    `${ocrText.trim()}\n` +
    `OCR TEXT END\n\n` +
    `Questions to answer on this page: ${allList}\n` +
    `- Multiple-choice questions (answer with a single capital letter A–E): ${mcList}\n` +
    `- Grammar-error questions (instructions include "ungrammatical / unacceptable / grammatical"; answer with a single digit 1–5 indicating which underlined part is wrong): ${grList}\n\n` +
    `OUTPUT RULES (VERY IMPORTANT):\n` +
    `1. For each question number above, output exactly one line in the form "<number>: <answer>".\n` +
    `   - For multiple-choice: use only A, B, C, D, or E.\n` +
    `   - For grammar-error questions: use only a digit 1, 2, 3, 4, or 5.\n` +
    `   - If the question or its options are not fully visible, answer "n/a".\n` +
    `2. After all answers, output one more line starting with "UNSURE:" followed by a comma-separated list of question numbers you are not confident about, or "-" if you are confident about all of them.\n` +
    `3. Finally, on the last line, output exactly "XURTH".\n` +
    `4. Do NOT include any explanations, translations, or extra text.\n\n` +
    `Your lines should look like this (example format only):\n` +
    `${linesSpec}\n` +
    `UNSURE: ...\n` +
    `XURTH\n`
  );
}

exports.handler = async (event) => {
  const body = safeJsonParse(event.body || "{}", {});
  const ocrText = String(body.text || "").trim();
  const page = body.page || 1;

  if (!ocrText) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        ok: false,
        error: "NO_TEXT",
        message: "OCR text is missing in request body.",
      }),
    };
  }

  if (!OPENROUTER_API_KEY) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        ok: false,
        error: "NO_API_KEY",
        message: "OPENROUTER_API_KEY is not set.",
      }),
    };
  }

  // 1) 문항 번호 전체 추출
  const questionNumbers = extractQuestionNumbers(ocrText);

  // 2) 문법 문항 번호 자동 감지
  const grammarNumbers = detectGrammarNumbers(ocrText, questionNumbers);

  // 3) 프롬프트 생성
  const prompt = buildPrompt(ocrText, questionNumbers, grammarNumbers);

  const modelName = "openai/gpt-4o-mini";
  const stopToken = "XURTH";

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site",
      },
      body: JSON.stringify({
        model: modelName,
        max_tokens: 500,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are a careful, deterministic exam solver. Follow the requested output format exactly; do not add explanations.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        statusCode: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          ok: false,
          error: "OPENROUTER_HTTP_ERROR",
          status: res.status,
          body: text,
        }),
      };
    }

    const data = await res.json();
    const choice = (data.choices && data.choices[0]) || {};
    const rawCompletion =
      (choice.message && choice.message.content) || "";
    const finishReason = choice.finish_reason || null;

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        ok: true,
        text: rawCompletion,
        debug: {
          page,
          questionNumbers,
          grammarNumbers,
          stopToken,
          model: modelName,
          finishReason,
          rawCompletion,
        },
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        ok: false,
        error: "OPENROUTER_REQUEST_FAILED",
        message: err && err.message ? err.message : String(err),
      }),
    };
  }
};
