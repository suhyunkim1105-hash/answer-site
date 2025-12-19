// netlify/functions/solve.js
// - Netlify Node 18: fetch 내장
// - OpenRouter Chat Completions 호출
// - deep / fast 모드 지원(기본 deep)
// - 입력 길이 제한/타임아웃/JSON 아닌 응답 방어

function json(headers, statusCode, obj) {
  return { statusCode, headers, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return json(headers, 200, { ok: true });
  if (event.httpMethod !== "POST") {
    return json(headers, 405, { ok: false, error: "METHOD_NOT_ALLOWED", message: "POST only" });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

  if (!apiKey) {
    return json(headers, 500, { ok: false, error: "NO_OPENROUTER_API_KEY", message: "OPENROUTER_API_KEY 없음" });
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
  const mode = (body.mode || "deep").toString(); // "deep" | "fast"

  if (!text || text.replace(/\s/g, "").length < 200) {
    return json(headers, 200, { ok: false, error: "TEXT_TOO_SHORT", message: "OCR 텍스트가 너무 짧음" });
  }

  // 긴 지문 대비: deep 모드는 조금 더 많이 보냄
  const MAX_SEND = mode === "deep" ? 11000 : 7000;
  const trimmed = text.length > MAX_SEND ? text.slice(-MAX_SEND) : text;

  // 글자수 목표(원고지 1000자 내외)
  const targetChars = typeof body.targetChars === "number" ? body.targetChars : 1000;
  const tol = typeof body.tolerance === "number" ? body.tolerance : 120;

  const baseSystem = [
    "너는 연세대학교 사회논술(사회복지/사회정책/불평등/권리/복지국가 관점) 상위권 답안을 쓰는 채점위원 겸 수험생이다.",
    "출력 형식은 절대 어기지 말라. 오직 아래 형태만 출력한다.",
    "[문제 1]",
    "(Q1 답안)",
    "[문제 2]",
    "(Q2 답안)",
    "마크다운/해설/메타코멘트/번호목록/단계 나열 금지. 한국어만. 인사말 금지.",
    `각 문제 답안은 원고지 기준 대략 ${targetChars}자 내외(±${tol}자)를 목표로 한다.`,
  ];

  // deep 모드: 내부적으로 먼저 분석→설계→최종 답안 한 번에 출력하도록 유도
  if (mode === "deep") {
    baseSystem.push(
      "",
      "[답안 생성 절차(외부 출력 금지)]",
      "1단계: 제시문·도표·문항을 모두 읽고, 출제 의도와 논점(쟁점)을 머릿속으로 정리한다.",
      "2단계: 각 문제별로 서론-본론-결론 구조, 사례/이론/정책 근거, 비교·비판 포인트를 머릿속으로 설계한다.",
      "3단계: 1~2단계 내용을 바탕으로 완성된 최종 답안만 출력한다.",
      "※ 1~2단계에서 만든 메모·초안·생각 과정은 절대 출력하지 말고, 최종 답안만 보여 준다."
    );
  } else {
    // fast 모드(참고용): 조금 더 간결하게
    baseSystem.push(
      "",
      "[작성 방식]",
      "핵심 논점과 논리 전개에 집중하여, 불필요한 반복을 줄이고 압축된 답안을 작성한다.",
      "그래도 서론-본론-결론 구조는 유지한다."
    );
  }

  if (force) {
    baseSystem.push(
      "",
      "입력이 불완전할 수 있다. 그래도 남은 텍스트로 최대한 출제 의도를 추론하여 일관된 답안을 완성하라."
    );
  }

  const system = baseSystem.join("\n");

  const user = [
    prefix ? prefix.trim() : "",
    "아래는 OCR로 추출된 시험지 텍스트이다. 제시문/문제/도표 설명을 읽고 요구 형식대로 답안을 작성하라.",
    "시험지는 연세대학교 사회논술(편입)이며, 영어 제시문 + 한국어 제시문 + 도표/그래프 설명이 섞여 있을 수 있다.",
    "도표 숫자/기호/%, 해설 메모가 보이면 답안에서 적극적으로 활용하라.",
    "----- OCR TEXT START -----",
    trimmed,
    "----- OCR TEXT END -----",
  ]
    .filter(Boolean)
    .join("\n");

  const controller = new AbortController();
  // Netlify 함수 자체의 상한이 있기 때문에, 이 타임아웃을 완전히 없앨 수는 없다.
  const timeoutMs = 22000;
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
        temperature: mode === "deep" ? 0.2 : 0.15,
        top_p: 0.9,
        max_tokens: 1900,
      }),
    }).finally(() => clearTimeout(timer));

    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) {
      const t = await resp.text().catch(() => "");
      return json(headers, 200, {
        ok: false,
        error: "NON_JSON_RESPONSE",
        message: "OpenRouter 응답이 JSON이 아님",
        detail: t.slice(0, 300),
        mode,
      });
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content || !content.trim()) {
      return json(headers, 200, {
        ok: false,
        error: "NO_ANSWER",
        message: "모델 응답 비어있음",
        raw: data,
        mode,
      });
    }

    let answer = content.trim();

    // 최소 형식 보정
    const hasQ1 = answer.includes("[문제 1]");
    const hasQ2 = answer.includes("[문제 2]");
    if (!hasQ1 || !hasQ2) {
      answer = `[문제 1]\n${answer}\n\n[문제 2]\n(문제 2 답안을 위 텍스트를 바탕으로 작성하라)`;
    }

    if (prefix && !answer.startsWith(prefix.trim())) {
      answer = `${prefix.trim()}\n${answer}`;
    }

    return json(headers, 200, { ok: true, answer, mode });
  } catch (e) {
    const isAbort = e && e.name === "AbortError";
    const msg = isAbort ? "OpenRouter 호출 타임아웃" : String(e?.message || e);
    return json(headers, 200, {
      ok: false,
      error: "SOLVE_FAILED",
      message: msg,
      aborted: isAbort,
      mode,
    });
  }
};
