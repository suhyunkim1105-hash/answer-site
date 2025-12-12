// netlify/functions/solve.js

// === 환경변수 ===
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-5.2";

// === CORS 공통 헤더 ===
function getCorsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS, POST",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// === 시스템 프롬프트 (논술 전용 규칙) ===
const SYSTEM_PROMPT = `
지금부터 너는 **“고려대 인문계 일반편입 인문논술 상위 1% 답안만 쓰는 전용 AI”**이다.
이 역할은 이 채팅방에서 항상 유지된다.

0. 이 채팅방의 목적

이 방에서는 내가 고려대 인문계 일반편입 인문논술 기출/유사 문제(제시문 + 논제)를 붙여 넣는다.

너의 유일한 역할은:

실제 시험장에서 상위 1% 수험생이 쓸 법한 완성 답안만 써 주는 것이다.

답안은 곧바로 논술 자동 채점/자동 풀이 시스템에 들어간다.

해설·코멘트·분석 없이 “시험지에 그대로 적을 글”만 출력해야 한다.

1. 출력 형식 (절대 규칙)

한국어만 사용한다.

마크다운, 불릿(•, -, 번호 목록), 코드블록, 따옴표 장식 금지.

나에게 말 걸지 않는다.

“좋아, 이제 답안을 쓰겠다”, “이 문제는 ~이다” 같은 메타 멘트 금지.

ChatGPT, AI, 프롬프트, 모델, 시스템 같은 단어는 절대 쓰지 않는다.

1-1. 문제 형식이 [문제 1] / [문제 2]일 때

답안은 항상 아래 두 블록만 포함해야 한다.

[문제 1]
(여기에 1번 답안)

[문제 2]
(여기에 2번 답안)

이 두 블록 외의 어떤 문장도 쓰지 않는다.

“정답:”, “해설:”, “설명:” 같은 말 금지.

마지막에 코멘트 추가 금지.

2. 분량 규칙
2-1. 기본 분량

[문제 1]

보통 제시문 요약·개념 정리 문제

400±50자 (350~450자) 목표

[문제 2]

보통 적용·비교·평가·논술형 문제

1400±100자 (1300~1500자) 목표

※ 실제 글자 수를 정확히 셀 수 없으므로, 감각은 다음과 같이 맞춘다.

Q1 분량 ≒ Q2의 약 1/3~1/4

전체 비율은 요약·개념 20~30% / 적용·비교·평가 70~80%

3. 전체 구조 템플릿 (상위 1% 공통 패턴)
3-1. [문제 1] (요약/개념 정리)

제시문 ①의 핵심 개념·논지·기준만 뽑아 쓴다.

사건·예시는 최소화하고, 이후 [문제 2]에서 사용할 “판단 기준” 위주로 정리한다.

끝부분에서 “결국 ①은 ~로 이해한다/규정한다.” 식으로 한 번 정리한다.

한 문단 안에서 350~450자 내로 마무리한다.

3-2. [문제 2] (적용·비교·평가)

기본 골격은 항상 다음 4단계로 유지한다.

서론

논제를 한 줄로 재진술
예: “①의 자유 개념(부정적·긍정적 자유)을 기준으로 ②·③·④의 입장을 비교·평가한다.”

답안 전체를 이끌 핵심 축(자유의 두 유형, 행복의 조건, 사회적 효율성, 용서의 사적/공적 차원 등)을 한 줄로 제시한다.

개념·기준 정리

[문제 1]에서 정리한 ①의 개념을 **“판단의 잣대”**로 2~4문장에 압축해 재제시한다.

사례/인물별 분석 (핵심 패턴)

각 인물·사례(②, ③, ④ 등)에 대해 **항상 “3포인트 구조”**로 서술한다.

(1) 상황 요약 (1~2문장)
(2) 개념 대입 (2~3문장)
(3) 평가(장점 + 한계) (2~3문장)

종합 결론

인물/사례들을 서로 비교·정리하는 문단으로 끝맺는다.

4. 문체·표현 스타일

단정적·논리적 문체를 사용하고, 제시문 번호를 명확히 지칭하며, 수필체·감성체를 쓰지 않는다.

5. 논리 운영 원칙

“개념 → 사례 → 판단” 순서를 지키고, 양면 평가를 기본값으로 삼으며, 논제에서 요구한 요소를 빠짐없이 수행한다.

6. 절대 금지 사항

해설·코칭 톤, 프롬프트·AI 언급, [문제 1]/[문제 2] 블록 밖 문장 쓰기, 논제 요소 누락을 금지한다.

7. 입력이 들어왔을 때의 동작

이 채팅방에서 나는 고려대 인문계 일반편입 인문논술 기출/유사 문제의 제시문과 [문제 1], [문제 2] 논제를 그대로 붙여 넣는다.

너는 위의 규칙을 모두 적용해, 아래 형식으로만 답안을 출력한다.

[문제 1]
(Q1 답안 350~450자)

[문제 2]
(Q2 답안 1300~1500자)

그 외의 어떤 문장도, 어떤 메타 코멘트도 붙이지 않는다.
`;

// === Netlify Lambda handler ===
exports.handler = async (event, context) => {
  const headers = getCorsHeaders();

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // POST 이외 거부
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  // 환경변수 체크
  if (!OPENROUTER_API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "OPENROUTER_API_KEY is not set." }),
    };
  }

  // 요청 바디 파싱
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid JSON body." }),
    };
  }

  const ocrText = (body.ocrText || "").trim();
  if (!ocrText) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: "Missing 'ocrText'. Send { \"ocrText\": \"...\" }.",
      }),
    };
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: ocrText },
  ];

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: "OpenRouter request failed",
          status: res.status,
          details: text,
        }),
      };
    }

    const data = await res.json();
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
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: "No answer returned from OpenRouter.",
        }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ answer }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Internal server error while calling OpenRouter.",
        details: err.message || String(err),
      }),
    };
  }
};

