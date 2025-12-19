// netlify/functions/solve.js
// - Netlify Node 18: fetch 내장
// - OpenRouter Chat Completions 호출
// - 입력 길이 제한/타임아웃/JSON 아닌 응답 방어
// - OpenRouter 호출 실패 시 최대 2회까지 자동 재시도

function json(headers, statusCode, obj) {
  return { statusCode, headers, body: JSON.stringify(obj) };
}

// OpenRouter 한 번 호출하는 헬퍼 (타임아웃 + 에러 정보 포함)
async function callOpenRouter({ apiKey, model, system, user, temperature, top_p, max_tokens, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "autononsul-demo",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature,
        top_p,
        max_tokens,
      }),
    });

    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    const rawText = await resp.text().catch(() => "");
    clearTimeout(timer);

    if (!ct.includes("application/json")) {
      return {
        ok: false,
        error: "NON_JSON_RESPONSE",
        message: "OpenRouter 응답이 JSON이 아님",
        detail: rawText.slice(0, 300),
      };
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return {
        ok: false,
        error: "JSON_PARSE_FAILED",
        message: "OpenRouter JSON 파싱 실패",
        detail: rawText.slice(0, 300),
      };
    }

    if (!resp.ok) {
      return {
        ok: false,
        error: "OPENROUTER_HTTP_ERROR",
        message: `OpenRouter HTTP ${resp.status}`,
        data,
      };
    }

    return { ok: true, data };
  } catch (e) {
    clearTimeout(timer);
    const msg = e && e.name === "AbortError"
      ? "OpenRouter 호출 타임아웃"
      : String(e && e.message ? e.message : e);
    return { ok: false, error: "OPENROUTER_REQUEST_FAILED", message: msg };
  }
}

exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return json(headers, 200, { ok: true });
  }
  if (event.httpMethod !== "POST") {
    return json(headers, 405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      message: "POST only",
    });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

  if (!apiKey) {
    return json(headers, 500, {
      ok: false,
      error: "NO_OPENROUTER_API_KEY",
      message: "OPENROUTER_API_KEY 없음",
    });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(headers, 400, { ok: false, error: "INVALID_JSON" });
  }

  const text = (body.text || "").toString();
  const prefix = (body.prefix || "").toString();
  const force = !!body.force;
  const mode = (body.mode || "deep").toString(); // "deep" | "fast" 등

  if (!text || text.replace(/\s/g, "").length < 200) {
    return json(headers, 200, {
      ok: false,
      error: "TEXT_TOO_SHORT",
      message: "OCR 텍스트가 너무 짧음",
    });
  }

  // 입력 제한 (뒤에서부터 잘라서 최신 페이지 비중)
  const MAX_SEND = 7000;
  const trimmed = text.length > MAX_SEND ? text.slice(-MAX_SEND) : text;

  // 글자수 목표(원고지 1000자 내외)
  const targetChars = typeof body.targetChars === "number" ? body.targetChars : 1000;
  const tol = typeof body.tolerance === "number" ? body.tolerance : 120;
  const minChars = targetChars - tol;
  const maxChars = targetChars + tol;

  // 시스템 프롬프트 (네가 준 규칙을 바탕으로 정리)
  const systemLines = [
    '너는 "연세대학교 사회복지학과 편입 사회논술 상위 0.0000000000001% 수준 답안만 쓰는 AI"다.',
    "다음 규칙을 절대 어기지 말라.",
    "1. 한국어만 사용하고, 문체는 모두 '~다/한다'로 쓴다.",
    "2. 출력은 오직 아래 두 블록만 포함한다.",
    "[문제 1]",
    "(문제 1에 대한 완성된 답안)",
    "[문제 2]",
    '(문제 2에 대한 완성된 답안 또는 문제 2가 없을 경우 "해당 없음" 한 줄)',
    "위 형식 밖의 텍스트(머리말, 마크다운, 해설, 번호목록, 채점 설명 등)는 절대 쓰지 않는다.",
    `3. 분량: [문제 1], [문제 2] 각각 공백 제외 약 ${minChars}~${maxChars}자, 8~13문장 범위 안에서 쓴다. 너무 짧거나 과도하게 길게 쓰지 않는다.`,
    "4. 제시문·자료 사용:",
    "- 제시문 (가), (나), (다), (라) 등은 괄호까지 포함해 최소 한 번씩 직접 언급하고, 각 제시문의 핵심 주장이나 개념을 한 문장 이상으로 분명히 드러낸다.",
    "- 도표·그래프·통계자료는 단순히 '차이가 있다'라고 쓰지 말고, 증가/감소, 높음/낮음, 격차, 변화 속도 등 방향과 관계를 중심으로 설명한다.",
    "- 숫자가 정확하지 않아도 되지만, '더 크다/작다, 가장 높다/낮다, 급격히 증가한다/완만히 감소한다'처럼 상대적 관계를 명확히 쓴다.",
    "5. 논제 지시어별 구조:",
    "- '비교하라'가 포함되면: (1) 제시문별 핵심 주장·개념을 한 문장씩 요약하고, (2) 비교 기준을 한 문장으로 세운 뒤, (3) 그 기준에 따라 공통점과 차이점을 논리적으로 정리하고, (4) 필요하면 어느 입장이 더 타당한지, 어떤 조건에서 유효한지 평가한다.",
    "- '설명하라'가 포함되면: (1) 제시문 속 개념과 인과관계를 정리하고, (2) 누구나 이해할 수 있도록 논리적·객관적 설명 위주로 쓴다.",
    "- '평가하라', '비판하라', '견해를 제시하라'가 포함되면: (1) 먼저 제시문 또는 자료의 주장을 요약하고, (2) 평가 기준(가치 판단 기준)을 한 문장으로 제시한 후, (3) 장점과 한계를 균형 있게 서술하고, (4) 결론을 제시문과 자료에 근거해 정리한다. 순수한 개인 경험이나 감정은 쓰지 않는다.",
    "- '자료를 해석하라'가 포함되면: (1) 자료의 핵심 경향과 특징(증가/감소, 순위, 격차, 변화 속도)을 먼저 설명하고, (2) 그 의미와 원인을 제시문 내용과 연결하여 해석한다.",
    "6. 문체·금지 규칙:",
    '- 1인칭 표현("나는", "필자는")과 감정적 표현("매우 나쁘다", "너무 안타깝다" 등)을 쓰지 않는다.',
    '- "이 글에서는 ~을 하겠다", "먼저 ~를 살펴보면"과 같은 메타 표현, 개요·해설·채점 코멘트는 쓰지 않는다.',
    "7. 구조:",
    "- 각 문제는 2~3개 단락으로 나누고, 서두에서 논제의 요구와 기준을 짧게 제시한 뒤, 본론에서 제시문·자료 분석과 비교·평가를 전개하고, 마지막에 한 줄 결론으로 마무리한다.",
  ];

  if (force) {
    systemLines.push(
      "8. 입력이 불완전하더라도 주어진 정보 안에서 최대한 논리적으로 완성된 답안을 작성한다."
    );
  }

  const system = systemLines.join("\n");

  const user = [
    prefix ? prefix.trim() : "",
    "아래는 OCR로 추출된 시험지 전체 텍스트이다. 제시문, 자료, 문제를 모두 읽고, 위 규칙에 맞는 [문제 1], [문제 2] 최종 답안만 작성하라.",
    "----- OCR TEXT START -----",
    trimmed,
    "----- OCR TEXT END -----",
  ]
    .filter(Boolean)
    .join("\n");

  // deep / fast 모드에 따라 약간의 파라미터 조정
  const temperature = mode === "fast" ? 0.18 : 0.22; // 둘 다 낮게, deep이 약간 더 유연
  const top_p = 0.9;
  const max_tokens = 1700;
  const timeoutMs = 22000;

  // OpenRouter 최대 2회 재시도
  let finalData = null;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await callOpenRouter({
      apiKey,
      model,
      system,
      user,
      temperature,
      top_p,
      max_tokens,
      timeoutMs,
    });

    if (res.ok && res.data) {
      finalData = res.data;
      break;
    }
    lastError = res;
  }

  if (!finalData) {
    return json(headers, 200, {
      ok: false,
      error: lastError && lastError.error ? lastError.error : "SOLVE_FAILED",
      message: lastError && lastError.message ? lastError.message : "OpenRouter 호출 실패(재시도 2회 후에도 응답 없음)",
      detail: lastError && lastError.detail ? lastError.detail : undefined,
    });
  }

  const content = finalData?.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    return json(headers, 200, {
      ok: false,
      error: "NO_ANSWER",
      message: "모델 응답 비어있음",
      raw: finalData,
    });
  }

  let answer = content.trim();

  // 최소 형식 보정: [문제 1], [문제 2]가 없으면 강제로 만들어 줌
  const hasQ1 = answer.includes("[문제 1]");
  const hasQ2 = answer.includes("[문제 2]");

  if (!hasQ1 || !hasQ2) {
    // 모델이 형식을 어겼을 때 대비해서 전체를 [문제 1]로 두고,
    // [문제 2]는 '해당 없음'으로 최소 보정
    answer = `[문제 1]\n${answer}\n\n[문제 2]\n해당 없음`;
  }

  if (prefix && !answer.startsWith(prefix.trim())) {
    answer = `${prefix.trim()}\n${answer}`;
  }

  return json(headers, 200, { ok: true, answer });
};

