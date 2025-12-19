// netlify/functions/solve.js
// - Netlify Node 18: fetch 내장
// - OpenRouter Chat Completions 호출
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

  if (!text || text.replace(/\s/g, "").length < 200) {
    return json(headers, 200, { ok: false, error: "TEXT_TOO_SHORT", message: "OCR 텍스트가 너무 짧음" });
  }

  // 입력 제한
  const MAX_SEND = 7000;
  const trimmed = text.length > MAX_SEND ? text.slice(-MAX_SEND) : text;

  // 글자수 목표(원고지 1000자 내외)
  const targetChars = typeof body.targetChars === "number" ? body.targetChars : 1000;
  const tol = typeof body.tolerance === "number" ? body.tolerance : 120;

  const system = [
    "너는 연세대학교 사회논술(사회복지/사회정책/불평등/권리/복지국가 관점) 상위권 답안을 쓰는 채점위원 겸 수험생이다.",
    "출력 형식은 절대 어기지 말라. 오직 아래 형태만 출력한다.",
    "[문제 1]",
    "(Q1 답안)",
    "[문제 2]",
    "(Q2 답안)",
    "마크다운/해설/메타코멘트/번호목록 금지. 한국어만. 인사말 금지.",
    `각 문제 답안은 원고지 기준 대략 ${targetChars}자 내외(±${tol}자)를 목표로 한다.`,
    force ? "입력이 불완전할 수 있다. 그래도 남은 텍스트로 최대한 완성하라." : "",
  ].join("\n");

  const user = [
    prefix ? prefix.trim() : "",
    "아래는 OCR로 추출된 시험지 텍스트이다. 제시문/문제/도표 설명을 읽고 요구 형식대로 답안을 작성하라.",
    "----- OCR TEXT START -----",
    trimmed,
    "----- OCR TEXT END -----",
  ].filter(Boolean).join("\n");

  const controller = new AbortController();
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
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 1700,
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
      });
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content || !content.trim()) {
      return json(headers, 200, { ok: false, error: "NO_ANSWER", message: "모델 응답 비어있음", raw: data });
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

    return json(headers, 200, { ok: true, answer });
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "OpenRouter 호출 타임아웃" : String(e?.message || e);
    return json(headers, 200, { ok: false, error: "SOLVE_FAILED", message: msg });
  }
};

