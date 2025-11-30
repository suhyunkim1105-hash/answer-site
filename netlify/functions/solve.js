// netlify/functions/solve.js
// OpenRouter를 이용해 Reading / Writing / Listening / Speaking 처리
// 실제 시험에서 사용 금지. 연습/연구용.

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.warn("OPENROUTER_API_KEY 환경변수가 설정되어 있지 않습니다.");
}

exports.handler = async function (event, context) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: "POST만 지원합니다.",
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const mode = body.mode || "reading";
    const passage = body.passage || "";
    const question = body.question || "";

    if (!question && !passage) {
      return {
        statusCode: 400,
        body: "passage 또는 question 중 하나는 있어야 합니다.",
      };
    }

    const { systemPrompt, userPrompt } = buildPrompts(mode, passage, question);

    const completion = await callOpenRouter(systemPrompt, userPrompt);

    const content =
      completion.choices?.[0]?.message?.content?.trim() || "";

    // Reading/Listening일 때는 "정답: 숫자" 패턴에서 숫자만 뽑아낸다.
    let answer = null;
    if (mode === "reading" || mode === "listening") {
      const m = content.match(/정답\s*[:：]\s*([1-5])/);
      if (m) answer = m[1];
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        mode,
        answer,
        raw: content,
      }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: "서버 오류: " + err.message,
    };
  }
};

// ===== 프롬프트 생성 =====
function buildPrompts(mode, passage, question) {
  let systemPrompt = "";
  let userPrompt = "";

  if (mode === "reading") {
    systemPrompt = `
너는 TOEFL iBT Reading 전문 튜터다.
항상 한국어로 설명한다.
문항은 객관식이며 보기 번호는 1~5까지 있다.
반드시 다음 형식을 지켜서 답하라:

1줄째: "정답: N" (N은 1~5 중 하나의 숫자만)
2줄째 이후: 왜 그 답이 정답인지, 다른 선택지는 왜 오답인지 간단히 한국어로 설명.
`;

    userPrompt = `
[지문]
${passage || "(지문 없음)"}

[문항]
${question}

위 정보를 바탕으로 정답 번호를 고르고 위 형식대로 답해라.
가능하면 TOEFL 스타일의 논리로 설명해라.
`;
  } else if (mode === "writing") {
    systemPrompt = `
너는 TOEFL iBT Writing 전문 튜터다.
항상 자연스러운 영어 에세이를 작성하고, 마지막에 한국어로 간단한 팁을 준다.
`;

    userPrompt = `
[쓰기 과제 설명 및 질문]
${question}

[관련 지문(있다면)]
${passage || "(지문 없음)"}

1) TOEFL 독립형/통합형 수준의 모범 에세이를 작성해라.
2) 구조는 서론-본론-결론이 드러나게 써라.
3) 분량은 250~320단어 정도로 한다.
4) 마지막에 한국어로 2~3줄 정도 "작성 팁"을 덧붙여라.
`;
  } else if (mode === "listening") {
    systemPrompt = `
너는 TOEFL iBT Listening 전문 튜터다.
항상 한국어로 설명한다.
리스닝 스크립트 또는 요약이 주어지고, 그에 대한 객관식 문항을 푸는 방식이다.
반드시 다음 형식을 지켜서 답하라:

1줄째: "정답: N" (N은 1~5 중 하나의 숫자)
2줄째 이후: 한국어로 핵심 근거를 정리하라.
`;

    userPrompt = `
[리스닝 내용의 스크립트 또는 요약]
${passage || "(스크립트/요약 없음)"}

[문항/보기]
${question}

위 정보를 바탕으로 가장 적절한 답 번호를 고르고, 위 형식대로 답해라.
`;
  } else if (mode === "speaking") {
    systemPrompt = `
너는 TOEFL iBT Speaking 전문 튜터다.
주어진 질문에 대한 모범 답변과 간단한 평가를 제공한다.
`;
    userPrompt = `
[스피킹 질문/프롬프트]
${question}

[관련 지문/노트(있다면)]
${passage || "(지문 없음)"}

1) TOEFL Speaking 기준에 맞는 모범 답변을 영어로 45~60초 분량으로 작성해라.
2) 답변 후, 한국어로 강점과 보완점에 대해 3~4줄 정도 피드백을 써라.
`;
  } else {
    // fallback: reading 스타일
    return buildPrompts("reading", passage, question);
  }

  return { systemPrompt, userPrompt };
}

// ===== OpenRouter 호출 =====
async function callOpenRouter(systemPrompt, userPrompt) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY 미설정");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.4,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error("OpenRouter 오류: " + text);
  }

  const json = await response.json();
  return json;
}


