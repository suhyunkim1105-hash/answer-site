// netlify/functions/solve.js

const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

exports.handler = async (event) => {
  try {
    // (선택) CORS가 필요하면 아래 2줄 추가 가능
    // BASE_HEADERS["Access-Control-Allow-Origin"] = "*";
    // BASE_HEADERS["Access-Control-Allow-Headers"] = "Content-Type, Authorization";

    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: BASE_HEADERS, body: "" };
    }

    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: BASE_HEADERS,
        body: JSON.stringify({ error: "Method Not Allowed" }),
      };
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return {
        statusCode: 400,
        headers: BASE_HEADERS,
        body: JSON.stringify({ error: "Invalid JSON in request body" }),
      };
    }

    const ocrText = (body.ocrText || "").trim();
    if (!ocrText) {
      return {
        statusCode: 400,
        headers: BASE_HEADERS,
        body: JSON.stringify({ error: "ocrText is required" }),
      };
    }

    // 타임아웃 방지: 입력 길이 제한
    const MAX_CHARS = 8000;
    const trimmed = ocrText.length > MAX_CHARS ? ocrText.slice(0, MAX_CHARS) : ocrText;

    const SYSTEM_PROMPT = `
너는 "고려대 인문계 일반편입 인문논술 상위 1% 답안만 쓰는 AI"다.

규칙:
1) 한국어만 사용한다. 마크다운, 불릿, 번호 목록, 코드블록을 쓰지 않는다.
2) 출력은 정확히 아래 두 블록만 포함한다.

[문제 1]
(1번 답안 문단)

[문제 2]
(2번 답안 문단)

3) [문제 1]은 400±50자(350~450자),
   [문제 2]는 1400±100자(1300~1500자) 분량으로 쓴다.
4) 개요, 해설, 구조 설명, 채점, 자기 언급, 프롬프트/모델 언급,
   "이 글에서는 ~을 하겠다", "먼저 ~을 살펴보자" 같은 메타 코멘트는 절대 쓰지 않는다.

입력으로는 OCR된 시험지 전체 텍스트(제시문, 문제 포함)가 주어진다.
과제: 문제의 요구에 맞는 [문제 1], [문제 2] 최종 답안만 작성하라.
`.trim();

    const userContent = `
다음은 OCR로 인식한 고려대 인문계 편입 논술 시험지 전체이다.

${trimmed}

위 시험지에 대해, 규칙을 지키면서 [문제 1], [문제 2] 최종 답안만 작성하라.
`.trim();

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: BASE_HEADERS,
        body: JSON.stringify({ error: "OPENROUTER_API_KEY is not set in environment" }),
      };
    }

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "autononsul",
      },
      body: JSON.stringify({
        model: "openrouter/auto",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.7,
        max_tokens: 1800, // 2048보다 살짝 줄여서 타임아웃/지연 리스크↓
      }),
    });

    const raw = await resp.text();

    // ✅ OpenRouter 자체 실패면 raw 그대로 반환(디버깅용)
    if (!resp.ok) {
      return {
        statusCode: resp.status,
        headers: BASE_HEADERS,
        body: JSON.stringify({
          error: "OpenRouter request failed",
          status: resp.status,
          raw: raw.slice(0, 4000),
        }),
      };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // JSON이 아닌 HTML/텍스트 오류가 올 때 대비
      return {
        statusCode: 502,
        headers: BASE_HEADERS,
        body: JSON.stringify({
          error: "Non-JSON response from OpenRouter",
          raw: raw.slice(0, 4000),
        }),
      };
    }

    const answer =
      data?.choices?.[0]?.message?.content &&
      typeof data.choices[0].message.content === "string"
        ? data.choices[0].message.content.trim()
        : "";

    if (!answer) {
      return {
        statusCode: 500,
        headers: BASE_HEADERS,
        body: JSON.stringify({
          error: "No answer from model",
          raw: raw.slice(0, 2000),
        }),
      };
    }

    return {
      statusCode: 200,
      headers: BASE_HEADERS,
      body: JSON.stringify({ answer }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: BASE_HEADERS,
      body: JSON.stringify({ error: "Server error", message: String(err?.message || err) }),
    };
  }
};

