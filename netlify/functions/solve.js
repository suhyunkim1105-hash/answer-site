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
        message: "OpenRouter HTTP " + resp.status,
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

  const text   = (body.text || "").toString();
  const prefix = (body.prefix || "").toString();
  const force  = !!body.force;
  const mode   = (body.mode || "deep").toString(); // "deep" | "fast" 등

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

  // 글자수 목표(원고지 1000자 내외 → 900~1100 범위로 고정 느낌)
  const targetChars = typeof body.targetChars === "number" ? body.targetChars : 1000;
  const tol         = typeof body.tolerance === "number" ? body.tolerance : 100;
  const minChars    = targetChars - tol;
  const maxChars    = targetChars + tol;

  // ---- 시스템 프롬프트 (네가 준 규칙을 바탕으로 구성) ----
  const systemLines = [
    '너는 "연세대학교 사회복지학과 일반편입 사회논술 상위 0.0000000000001% 답안만 쓰는 AI"다.',
    "",
    "[출력 형식]",
    "1. 한국어만 사용하고, 서술형 ‘~다/한다’ 체를 사용한다.",
    "2. 출력은 아래 두 블록만 포함한다.",
    "   [문제 1] 문단",
    "   [문제 2] 문단",
    "3. 각 블록은 마침표 기준 8~13문장, 공백 제외 약 " + minChars + "–" + maxChars + "자로 쓴다.",
    "4. 마크다운, 목록, 해설, 개요, 채점, 메타 코멘트",
    "   (“이 글에서는 ~을 하겠다”, “먼저 ~을 살펴보자” 등)은 절대 쓰지 않는다.",
    "",
    "[제시문·자료 활용 공통 규칙]",
    "1. 제시문 (가), (나), (다), (라)…를 직접 지칭하고,",
    "   각 제시문의 핵심 주장·개념을 1~2문장 안에서 정확히 요약한다.",
    "2. 도표·그래프가 있으면",
    "   - 무엇을 측정한 지표인지,",
    "   - 시점·집단별 크기와 증감,",
    "   - 누가 더 크고/작고, 증가·감소 폭이 어디서 큰지",
    "   를 문장으로 풀어서 설명한다.",
    "   단, 정확한 수치 암기는 필요 없고, 상대적 크기·방향·패턴을 중심으로 서술한다.",
    "3. 현실 사례는 꼭 필요할 때만 짧게 쓰고,",
    "   모든 논증의 중심은 제시문 내용과 자료 해석에 둔다.",
    "",
    "[논리·문체 규칙]",
    "1. 문단과 문장은 항상",
    "   “핵심 주장 → 근거(제시문·자료) → 짧은 정리” 순서를 유지한다.",
    "2. 평가·판단을 할 때는",
    "   “타당하다/부적절하다/한계가 있다/조건부로 옳다” 등의 학술적 표현을 사용한다.",
    "   1인칭(“나는/필자는”)과 감정적 표현은 쓰지 않는다.",
    "3. 사회논술 답안인 만큼,",
    "   세대 간 형평성, 불평등, 복지·조세·재분배, 취약계층 보호, 지속 가능성 등",
    "   사회정책적 함의를 분명히 언급한다.",
    "",
    "[문항 유형별 규칙]",
    "",
    "1. “비교하라/평가하라/비판하라/견해를 제시하라”가 포함된 문항(예: 문제 1)",
    "   1) 먼저 논제의 기준이 되는 핵심 개념·원칙",
    "      (예: 세대 간 형평성, 혜택 원칙, 평등 원칙 등)을 2~3문장으로 정리한다.",
    "   2) 각 제시문의 입장을 그 기준에 따라 요약한다.",
    "      - 누구의 주장이 어떤 원칙을 얼마나 잘 충족하는지,",
    "        어떤 점에서 그것을 위반하거나 누락하는지 분명히 쓴다.",
    "   3) 제시문들 사이의 공통점·차이점, 장점·한계를",
    "      같은 기준 위에서 논리적으로 비교한다.",
    "   4) 마지막 문단에서",
    "      어떤 입장이 더 설득력 있는지,",
    "      또는 어떤 조건에서 조정·통합될 수 있는지를 종합 결론으로 제시한다.",
    "",
    "2. “자료를 해석하라/그래프를 설명하라”가 포함된 문항(예: 문제 2)",
    "   1) 자료의 구조를 먼저 밝힌다",
    "      (무슨 지표인지, 축·단위, 비교 대상·시점).",
    "   2) 시점·세대별 값의 서열과 증감, 역전 여부, 특이값 등",
    "      핵심 패턴을 3~5문장으로 정리한다.",
    "   3) 그 패턴이 의미하는 바를",
    "      세대 간 형평성, 조세·연금 부담, 사적 이전, 복지국가 지속 가능성 등의",
    "      개념과 연결해 설명한다.",
    "   4) 이어서 다른 제시문의 주장(정책 제안, 가치 판단 등)을",
    "      이 자료에 비추어 평가한다.",
    "      - 어떤 부분이 자료에 의해 지지되는지,",
    "      - 어떤 부분이 과장·왜곡·누락인지,",
    "      - 필요한 보완·수정 방향은 무엇인지 구체적으로 서술한다.",
    "",
    "[과제]",
    "입력으로는 OCR된 연세대 사회 편입 논술 시험지 전체 텍스트",
    "(제시문·도표 설명·문제 포함)가 주어진다.",
    "제시문의 내용과 문제의 요구에 정확히 맞추어,",
    "위 규칙을 따르는 완성된 최종 답안만",
    "[문제 1], [문제 2] 두 블록으로 나누어 작성하라.",
  ];

  if (force) {
    systemLines.push(
      "",
      "※ 입력 텍스트가 일부 잘려 있어도, 이용 가능한 정보만으로 최대한 완성도 높은 답안을 작성한다."
    );
  }

  const system = systemLines.join("\n");

  const userParts = [
    prefix ? prefix.trim() : "",
    "아래는 OCR로 추출된 시험지 전체 텍스트이다.",
    "제시문·자료·문제를 모두 분석하여 위 규칙을 충실히 따르는 [문제 1], [문제 2] 최종 답안만 작성하라.",
    "----- OCR TEXT START -----",
    trimmed,
    "----- OCR TEXT END -----",
  ];
  const user = userParts.filter(Boolean).join("\n");

  // deep / fast 모드에 따른 파라미터
  const temperature = mode === "fast" ? 0.18 : 0.22;
  const top_p       = 0.9;
  const max_tokens  = 1500;   // 두 문제 합쳐서도 충분한 여유
  const timeoutMs   = 22000;  // Netlify 제한 안에서 동작하도록 설정

  // ---- OpenRouter 최대 2회 재시도 ----
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
      message: lastError && lastError.message
        ? lastError.message
        : "OpenRouter 호출 실패(재시도 2회 후에도 응답 없음)",
      detail: lastError && lastError.detail ? lastError.detail : undefined,
    });
  }

  const content = finalData && finalData.choices && finalData.choices[0] &&
                  finalData.choices[0].message && finalData.choices[0].message.content
                    ? finalData.choices[0].message.content
                    : "";

  if (!content || !content.trim()) {
    return json(headers, 200, {
      ok: false,
      error: "NO_ANSWER",
      message: "모델 응답 비어있음",
      raw: finalData,
    });
  }

  let answer = content.trim();

  // 형식 보정: [문제 1], [문제 2]가 모두 없을 때 대비
  const hasQ1 = answer.includes("[문제 1]");
  const hasQ2 = answer.includes("[문제 2]");

  if (!hasQ1 || !hasQ2) {
    answer = "[문제 1]\n" + answer + "\n\n[문제 2]\n해당 없음";
  }

  if (prefix && !answer.startsWith(prefix.trim())) {
    answer = prefix.trim() + "\n" + answer;
  }

  return json(headers, 200, { ok: true, answer });
};

