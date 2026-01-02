// netlify/functions/solve.js
// 성균관대 기출 전체를 대상으로 동작하도록 만든 버전
// - 실제 문항 번호는 줄 맨 앞의 "01." / "7)" 패턴으로만 추출
// - "ungrammatical / unacceptable / grammatical" 이 포함된 범위는 문법 문항으로 간주하고
//   그 범위의 번호는 1~5(밑줄 번호)로 답하게 함

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// 안전하게 JSON 파싱
function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// 줄 맨 앞에서만 문항 번호 추출 (01. / 7. / 23) 등)
function extractQuestionNumbers(ocrText) {
  const pattern = /(?:^|\n)\s*(\d{1,2})\s*[.)]/g;
  const found = new Set();
  let m;
  while ((m = pattern.exec(ocrText)) !== null) {
    const num = parseInt(m[1], 10);
    if (Number.isInteger(num) && num >= 1 && num <= 50) {
      found.add(num);
    }
  }
  return Array.from(found).sort((a, b) => a - b);
}

// [06-10] Choose one that is either ungrammatical or unacceptable.
// 같은 범위를 찾아서, "ungrammatical / unacceptable / grammatical" 이 포함된 범위는 문법 문항으로 분류
function detectGrammarNumbers(ocrText, questionNumbers) {
  const rangePattern = /\[(\d{1,2})\s*-\s*(\d{1,2})\]\s*([^\n]+)/g;
  const grammarRanges = [];
  let m;

  while ((m = rangePattern.exec(ocrText)) !== null) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    const instruction = (m[3] || "").toLowerCase();

    const isGrammar =
      instruction.includes("ungrammatical") ||
      instruction.includes("unacceptable") ||
      instruction.includes("grammatical");

    if (isGrammar && Number.isInteger(start) && Number.isInteger(end)) {
      grammarRanges.push({ start, end });
    }
  }

  const qSet = new Set(questionNumbers);
  const grammarSet = new Set();

  for (const r of grammarRanges) {
    for (let n = r.start; n <= r.end; n++) {
      if (qSet.has(n)) {
        grammarSet.add(n);
      }
    }
  }

  return Array.from(grammarSet).sort((a, b) => a - b);
}

// OpenRouter에 넘길 프롬프트 생성
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

  // 1) 문항 번호 추출
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
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        // 선택: OpenRouter 측에서 출처 표시용
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
