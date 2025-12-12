// netlify/functions/solve.js

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: "Method Not Allowed",
      };
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return {
        statusCode: 400,
        body: "Invalid JSON in request body",
      };
    }

    const ocrText = (body.ocrText || "").trim();

    if (!ocrText) {
      return {
        statusCode: 400,
        body: "ocrText is required",
      };
    }

    // 너무 긴 텍스트로 인한 타임아웃 방지용 (대략 8,000자까지만 사용)
    const MAX_CHARS = 8000;
    let trimmed = ocrText;
    if (trimmed.length > MAX_CHARS) {
      trimmed = trimmed.slice(0, MAX_CHARS);
    }

    const systemPrompt = `
너는 "고려대 인문계 일반편입 인문논술 상위 1% 답안만 쓰는 AI"이다.

역할:
- OCR로 인식한 고려대학교 인문계 일반편입 인문논술 기출·유사문항을 읽고,
- 실제 시험장에서 쓸 수 있는 수준의 "현실적인" 모범답안을 작성한다.
- 과한 철학 에세이나 문학적 수사는 피하고, 논리·개념·구조 중심으로 쓴다.
`.trim();

    const userPrompt = `
다음은 카메라 + OCR로 인식한 고려대 인문논술 문제 전체이다.

[문제 전체 OCR]
${trimmed}

위 문제를 분석하여, 실제 시험장에서 쓸 수 있는 모범답안을 작성하라.

출력 규칙(절대 지켜라):
1. 한국어만 사용한다.
2. 오직 완성된 답안만 쓴다.
3. 출력은 정확히 아래 두 블록만 포함한다.

[문제 1]
(문제 1 답안 본문 350~450자 정도, 한 문단 또는 두 문단)

[문제 2]
(문제 2 답안 본문 1300~1500자 정도, 서론-본론-결론 구조를 갖춘 글)

4. 개요, 해설, 메타 코멘트(예: "이 글에서는 ~을 하겠다", "먼저 ~을 살펴보자")를 쓰지 않는다.
5. 번호, 글머리표, 마크다운, 목록을 쓰지 말고 순수한 문단 형식으로만 작성한다.
6. 글자 수는 대략 맞추되, 너무 짧거나 지나치게 길지 않게 조정한다.
`.trim();

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: "OPENROUTER_API_KEY is not set in environment",
      };
    }

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "autononsul",
      },
      body: JSON.stringify({
        // 추측입니다: 모델 이름은 필요하면 나중에 바꿔도 된다.
        model: "openrouter/auto",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 2048,
      }),
    });

    const raw = await resp.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      // 예전처럼 HTML 에러(<HTML> Inactivity Timeout 등)이 올 때를 대비해서
      return {
        statusCode: resp.status,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: raw,
      };
    }

    const answer =
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      typeof data.choices[0].message.content === "string"
        ? data.choices[0].message.content.trim()
        : "";

    if (!answer) {
      return {
        statusCode: 500,
        body: "No answer from model",
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: answer,
    };
  } catch (err) {
    console.error("solve error", err);
    return {
      statusCode: 500,
      body: "Server error: " + err.message,
    };
  }
};
