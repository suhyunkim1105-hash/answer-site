// netlify/functions/solve.js
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, { ok: false, error: "OPENROUTER_API_KEY is not set" });
    }

    const model = process.env.MODEL_NAME || "openai/gpt-4.1";
    const temperature = Number(process.env.TEMPERATURE ?? 0.1);
    // 🔹 출력 토큰 상한 (없으면 512)
    const maxTokens = Number(process.env.MAX_OUTPUT_TOKENS || 512);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const ocrText = String(body.ocrText || body.text || "");

    if (!ocrText.trim()) {
      return json(400, { ok: false, error: "Missing ocrText" });
    }

    const prompt = buildPrompt(ocrText);

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "",
        "X-Title": process.env.OPENROUTER_APP_NAME || "answer-site",
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens, // 🔹 여기 한 줄만 실제 요청에 추가
        // ❌ stop 토큰 사용 안 함
        messages: [
          { role: "system", content: "You output ONLY answers in the required format. No extra text." },
          { role: "user", content: prompt }
        ],
      }),
    });

    const raw = await res.text();
    if (!res.ok) {
      return json(res.status, {
        ok: false,
        error: "OpenRouter error",
        raw: raw.slice(0, 1500),
      });
    }

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      // 응답이 JSON이 아니면 에러 처리
      return json(502, { ok: false, error: "Invalid JSON from OpenRouter", raw: raw.slice(0, 1500) });
    }

    const text = data?.choices?.[0]?.message?.content
      ? String(data.choices[0].message.content)
      : "";
    const finishReason = data?.choices?.[0]?.finish_reason || null;

    const { questionNumbers, answers } = parseAnswers(text);

    return json(200, {
      ok: true,
      text,
      debug: {
        page,
        model,
        questionNumbers,
        answers,
        finishReason,
        ocrTextPreview: ocrText.slice(0, 400),
      },
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "Internal server error in solve",
      detail: String(e?.message || e),
    });
  }
};

function buildPrompt(ocrText) {
  return `
You are solving a multiple-choice test from OCR text.

RULES:
- Output ONLY in this format:
1: A
2: B
...
UNSURE: (list numbers or '-')

- No explanations.
- If OCR is unclear for a number, put that number into UNSURE.

OCR TEXT:
${ocrText}
`.trim();
}

function parseAnswers(text) {
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const answers = {};
  const questionNumbers = [];

  for (const ln of lines) {
    const m = ln.match(/^(\d{1,3})\s*:\s*([ABCDE0-9])\b/i);
    if (m) {
      const n = Number(m[1]);
      const a = m[2].toUpperCase();
      // A~E → 1~5, 숫자면 그대로 숫자로 (둘 다 허용)
      let val;
      if ("ABCDE".includes(a)) {
        val = "ABCDE".indexOf(a) + 1;
      } else {
        val = Number(a);
      }
      answers[String(n)] = val;
      questionNumbers.push(n);
    }
  }

  questionNumbers.sort((a, b) => a - b);
  return { questionNumbers, answers };
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

