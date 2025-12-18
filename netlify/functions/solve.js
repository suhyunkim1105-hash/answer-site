// netlify/functions/solve.js

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: false, error: "Method not allowed" }),
    };
  }

  if (!OPENROUTER_API_KEY) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: false, error: "OPENROUTER_API_KEY missing" }),
    };
  }

  try {
    const { text, force, prefix } = JSON.parse(event.body || "{}");

    if (!text || typeof text !== "string") {
      return {
        statusCode: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ ok: false, error: "text is required" }),
      };
    }

    // 너무 긴 입력은 뒤에서부터 8000자만 사용
    const MAX_INPUT = 8000;
    const trimmed = text.length > MAX_INPUT ? text.slice(-MAX_INPUT) : text;

    const systemPrompt = [
      "너는 연세대학교 사회논술(사회복지·사회정책·불평등·권리·복지국가 관점)에 대해 상위 0.0001% 수준의 답안을 쓰는 채점위원 겸 수험생이다.",
      "",
      "출력 형식을 절대 어기지 말라. 오직 아래 형태만 출력한다.",
      "[문제 1]",
      "(문제 1에 대한 완성된 답안 문단)",
      "[문제 2]",
      "(문제 2에 대한 완성된 답안 문단)",
      "",
      "규칙:",
      "- 한국어만 사용한다.",
      "- 마크다운, 목록(①, 1., bullet), 해설, 메타 코멘트(예: '이 글에서는 ~을 살펴본다')를 쓰지 않는다.",
      "- 두 답안 모두 현실적인 시험 시간/분량을 고려한 밀도 높은 논리 전개를 할 것.",
      "- 각 답안은 원고지 기준 대략 1000자 내외, 즉 900~1100자 정도 분량을 목표로 한다.",
      "- 분량 안에서 핵심 개념 정의, 제시문 간 비교, 비판/평가, 구체적인 정책·제도·사례까지 최대한 압축해서 담는다.",
      force
        ? "- 현재 제시문 텍스트가 일부 잘렸을 수 있다. 그래도 보이는 정보만 최대한 활용해 완성도 높은 답안을 작성하라."
        : "",
    ].join("\n");

    const userPrompt =
      (prefix || "") +
      "\n\n" +
      "다음은 연세대학교 사회논술 시험지 전체 OCR 텍스트다. 제시문, 도표 설명, [문제 1], [문제 2]를 모두 포함한다.\n" +
      "이 텍스트를 기반으로 위 규칙을 지켜서, 상위 1% 수험생이 실제 시험에서 쓸 법한 현실적인 답안을 작성하라.\n\n" +
      "----- OCR 텍스트 시작 -----\n" +
      trimmed +
      "\n----- OCR 텍스트 끝 -----\n";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 22000); // 최대 22초

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-5.1-mini", // 가볍고 빠른 모델(원하면 다른 모델로 수정 가능)
        max_tokens: 1700,
        temperature: 0.4,
        top_p: 0.9,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
    }).catch((err) => {
      clearTimeout(timeout);
      throw err;
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        statusCode: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          ok: false,
          error: "OpenRouter API error",
          detail,
        }),
      };
    }

    const data = await response.json();
    const answer =
      data.choices?.[0]?.message?.content?.trim() ||
      "";

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: true, answer }),
    };
  } catch (err) {
    console.error("solve error", err);
    const msg =
      err.name === "AbortError"
        ? "모델 응답 시간이 너무 오래 걸려 중단되었습니다."
        : "Unexpected error in solve function";

    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: false, error: msg }),
    };
  }
};
