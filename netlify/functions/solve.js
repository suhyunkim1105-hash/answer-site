// netlify/functions/solve.js

// 🔹 고정 시스템 프롬프트 (고려대 인문계 일반편입 상위 1% 답안 전용)
const SYSTEM_PROMPT = `
너는 "고려대 인문계 일반편입 인문논술 상위 1% 답안만 쓰는 전용 AI"이다.

규칙:
1. 한국어만 사용한다.
2. 출력 형식은 항상 아래 두 블록만 포함한다.
[문제 1]
(1번 답안)

[문제 2]
(2번 답안)
두 블록 이름([문제 1], [문제 2])을 바꾸지 말고, 이 밖의 문장은 절대 쓰지 않는다.
3. 마크다운, 불릿, 코드블록, 따옴표 장식, "정답:", "해설:" 같은 말은 절대 쓰지 않는다.
4. "AI, 챗봇, 프롬프트, 모델, 시스템" 등 메타 표현과
   "이 글에서는 ~을 하겠다" 같은 메타 멘트는 쓰지 않는다.
5. 분량:
   - [문제 1] : 350~450자 수준, 제시문 ①의 개념·논지를 요약하고 판단 기준을 정리한다.
   - [문제 2] : 1300~1500자 수준, ①의 기준으로 ②·③·④(또는 논제에 제시된 대상)을 비교·평가하고 종합 결론을 쓴다.
6. 문체:
   - 논리적인 평서체 ("~라고 볼 수 있다", "~로 이해된다", "~라고 평가할 수 있다")를 사용한다.
   - 수필체·감성체·개인 경험담·비유적 표현은 쓰지 않는다.
   - 필요할 때만 "필자는 ~라고 본다"를 제한적으로 사용하고, 기본은 객관화된 서술을 사용한다.
7. 논리 구조:
   - 항상 "개념 → 사례 → 판단" 순서로 쓴다.
   - 제시문을 지칭할 때는 "제시문 ①, ②, ③, ④"처럼 번호를 분명히 적는다.
   - 각 인물·사례에 대해 "상황 요약 → ①의 기준 대입 → 장점 + 한계"의 양면 평가를 한다.
   - 종합 결론에서는 인물·사례들 사이의 관계를 정리하고, ①이 제시한 틀의 의의와 한계를 개념적으로 정리한다.
8. 현실성:
   - 실제 상위 1% 수험생이 시험장에서 시간 내에 쓸 수 있는 밀도와 분량으로 쓴다.
   - 논제의 요구(요약, 비교, 평가, 견해 제시 등)를 빠짐없이 모두 수행하는 것을 최우선으로 한다.

사용자는 아래에 고려대 인문계 일반편입 인문논술의 제시문 ①, ②, ③, ④와
[문제 1], [문제 2] 논제를 그대로 붙여 넣는다.
너는 그 전체 텍스트를 읽고, 위의 규칙을 모두 지켜서
곧바로 아래 형식으로만 답안을 작성한다.

[문제 1]
(Q1 답안 350~450자)

[문제 2]
(Q2 답안 1300~1500자)
`;

// 🔹 공통 CORS 헤더
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

// Netlify Functions 엔트리포인트
exports.handler = async function (event, context) {
  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "POST only" }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const rawOcrText = (body.ocrText || "").trim();

  if (!rawOcrText) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "ocrText is required" }),
    };
  }

  // 🔹 긴 제시문 → 처리 시간 줄이려고 강제 길이 제한 (오늘 밤 MVP 우회용)
  //  - 뒤쪽에 [문제 1], [문제 2]가 있는 경우가 많으므로 "뒤에서부터" 자른다.
  const MAX_INPUT_CHARS = 6000; // 필요하면 8000 정도까지 올릴 수 있음
  let ocrText = rawOcrText;
  let truncated = false;
  if (rawOcrText.length > MAX_INPUT_CHARS) {
    ocrText = rawOcrText.slice(-MAX_INPUT_CHARS);
    truncated = true;
  }

  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const OPENROUTER_MODEL =
    process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini-2024-07-18";

  if (!OPENROUTER_API_KEY) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "OPENROUTER_API_KEY not set in environment",
      }),
    };
  }

  // 🔹 OpenRouter 호출 payload
  const payload = {
    model: OPENROUTER_MODEL,
    max_tokens: 1900, // Q1+Q2 합산 충분 + 과한 토큰 방지
    temperature: 0.3,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: ocrText,
      },
    ],
  };

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site",
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();

    if (!res.ok) {
      // OpenRouter 쪽 에러를 그대로 보여줘서 디버깅에 쓰기
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "OpenRouter request failed",
          status: res.status,
          body: text.slice(0, 1000),
        }),
      };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "Failed to parse OpenRouter JSON",
          raw: text.slice(0, 1000),
        }),
      };
    }

    const answer =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      typeof data.choices[0].message.content === "string"
        ? data.choices[0].message.content.trim()
        : "";

    if (!answer) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "No answer generated",
          openrouterResponse: data,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        answer,
        truncated,          // 길이 잘랐는지 여부 (디버깅용)
        inputLength: rawOcrText.length,
        usedLength: ocrText.length,
        model: OPENROUTER_MODEL,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "Request to OpenRouter threw",
        message: err.message || String(err),
      }),
    };
  }
};
