// netlify/functions/solve.js

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Method Not Allowed" }),
    };
  }

  if (!OPENROUTER_API_KEY) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Missing OPENROUTER_API_KEY" }),
    };
  }

  try {
    const { ocrText, page } = JSON.parse(event.body || "{}");

    if (!ocrText || typeof ocrText !== "string") {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Missing ocrText" }),
      };
    }

    // 1. 문제 번호 추출 (라인 맨 앞의 숫자 + . 또는 숫자 + 공백 패턴만 인정)
    const questionNumbers = extractQuestionNumbers(ocrText);

    // 일단 성균관대 형식을 가정해서 6~10번을 문법 문제로 표시
    const grammarNumbers = questionNumbers.filter((n) => n >= 6 && n <= 10);

    // 2. 프롬프트 구성
    const systemPrompt = [
      "You are an expert English exam solver.",
      "You receive OCR text of a multiple-choice English test page.",
      "Your task is to choose the correct option for EACH question number provided.",
      "",
      "Rules:",
      "- Questions are numbered (e.g., 1., 2., 3., ...).",
      "- Each question has five options labeled A, B, C, D, E.",
      "- You MUST output answers ONLY in numeric form 1–5, where:",
      "  1 = A, 2 = B, 3 = C, 4 = D, 5 = E.",
      "- Do NOT invent question numbers; answer ONLY the ones I list.",
      "- If you are really unsure about a question, you may list its number in the UNSURE line at the end.",
      "",
      "Output format MUST be:",
      "13: 2",
      "14: 1",
      "15: 5",
      "...",
      "UNSURE: -",
      "XURTH",
      "",
      "Important: one line per question, in ascending order, exactly '<number>: <digit>'.",
      "UNSURE line must be last but one, and XURTH must be the final line."
    ].join("\n");

    const questionsList = questionNumbers.join(", ");

    const userPrompt = [
      "Here is the OCR text of the exam page:",
      "==== OCR TEXT START ====",
      ocrText,
      "==== OCR TEXT END ====",
      "",
      `Question numbers to answer: ${questionsList}`,
      "",
      "For EACH of these question numbers, choose the best option (1–5).",
      "Remember: 1=A, 2=B, 3=C, 4=D, 5=E.",
      "",
      "Respond ONLY in this format:",
      "13: 2",
      "14: 1",
      "15: 5",
      "UNSURE: -",
      "XURTH"
    ].join("\n");

    // 3. OpenRouter 호출 (결정론적 설정)
    const body = {
      model: "openai/gpt-4o-mini",
      temperature: 0,
      top_p: 1,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: false,
          error: "OpenRouter error",
          detail: errText,
        }),
      };
    }

    const data = await resp.json();
    const rawCompletion =
      data.choices?.[0]?.message?.content?.trim() || "";

    // 4. 모델 출력 파싱 (숫자/알파벳 둘 다 방어적으로 처리)
    const parsed = parseAnswers(rawCompletion, questionNumbers);

    // 프런트에서 보기 좋게 다시 텍스트로 포맷
    const text = formatAnswerText(parsed.answers, questionNumbers);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        text,
        debug: {
          page: page ?? null,
          questionNumbers,
          grammarNumbers,
          model: body.model,
          rawCompletion,
          parsed,
        },
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: "Server error",
        detail: err.message,
      }),
    };
  }
};

/**
 * OCR 텍스트에서 문제 번호 추출
 * - 라인 맨 앞에 오는 1~50 숫자 + . 또는 공백 기준으로만 인식
 */
function extractQuestionNumbers(ocrText) {
  const regex = /(^|\n)\s*(\d{1,2}|50)\s*[.)]/g;
  const nums = new Set();
  let m;
  while ((m = regex.exec(ocrText)) !== null) {
    const n = parseInt(m[2], 10);
    if (n >= 1 && n <= 50) {
      nums.add(n);
    }
  }
  return Array.from(nums).sort((a, b) => a - b);
}

/**
 * 모델 출력에서 "번호: 값" 파싱
 * - 값이 숫자(1~5)이면 그대로 사용
 * - 값이 A~E이면 1~5로 변환
 * - 없는 번호는 null로 채움
 */
function parseAnswers(completion, questionNumbers) {
  const answers = {};
  const unsure = new Set();

  const lines = completion
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const lineRegex = /^(\d{1,2})\s*:\s*([1-5A-Ea-e]|n\/a|na|-)\b/;

  for (const line of lines) {
    // UNSURE 라인 처리
    if (/^UNSURE/i.test(line)) {
      const parts = line.split(":");
      if (parts[1]) {
        parts[1]
          .split(/[,\s]+/)
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .forEach((token) => {
            const n = parseInt(token, 10);
            if (!Number.isNaN(n)) unsure.add(n);
          });
      }
      continue;
    }

    const m = lineRegex.exec(line);
    if (!m) continue;

    const q = parseInt(m[1], 10);
    if (!questionNumbers.includes(q)) continue;

    let val = m[2].trim();

    // A~E → 1~5 변환
    if (/^[A-Ea-e]$/.test(val)) {
      val = (val.toUpperCase().charCodeAt(0) - 64).toString(); // A=1 ...
    }

    if (/^[1-5]$/.test(val)) {
      answers[q] = parseInt(val, 10);
    }
  }

  // 빠진 번호는 null로 채우기
  for (const q of questionNumbers) {
    if (!(q in answers)) {
      answers[q] = null;
    }
  }

  return {
    answers,
    unsure: Array.from(unsure),
  };
}

/**
 * answers 객체를 다시 "번호: 값" 텍스트로 만들어서 프런트에 보내기
 */
function formatAnswerText(answers, questionNumbers) {
  const lines = [];

  for (const q of questionNumbers) {
    const v = answers[q];
    const out = v === null ? "n/a" : String(v);
    lines.push(`${q}: ${out}`);
  }

  // 일단 UNSURE는 안 쓰더라도 형식 유지
  lines.push("UNSURE: -");
  lines.push("XURTH");

  // 프런트 로그에서 줄바꿈이 보이도록 마크다운 스타일 줄바꿈 유지
  return lines.join("  \n");
}
