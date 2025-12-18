exports.handler = async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: "POST only" }) };
  }

  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

    if (!apiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ ok: false, error: "OPENROUTER_API_KEY 환경변수가 없음" }),
      };
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "JSON 파싱 실패" }) };
    }

    const text = (body.text || "").toString();
    const force = !!body.force;
    const prefix = (body.prefix || "").toString();

    if (!text || text.trim().length < 10) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "solve에 보낼 text가 너무 짧음" }) };
    }

    const MAX = 8000;
    const trimmed = text.length > MAX ? text.slice(-MAX) : text;

    const system = [
      "너는 연세대학교 사회논술(사회복지/사회정책/불평등/권리/복지국가 관점) 상위권 답안을 쓰는 채점위원 겸 수험생이다.",
      "출력 형식을 절대 어기지 말라. 오직 아래 형태만 출력한다.",
      "[문제 1]",
      "(Q1 답안 문단)",
      "[문제 2]",
      "(Q2 답안 문단)",
      "마크다운/해설/메타코멘트/번호목록 금지. 한국어만. 불필요한 인사말 금지.",
      force ? "현재 입력이 불완전할 수 있다. 그래도 남은 텍스트로 최대한 답안을 완성하라." : ""
    ].join("\n");

    const user = [
      prefix ? prefix.trim() : "",
      "아래는 OCR로 추출된 시험지 텍스트이다. 제시문과 문제를 읽고 요구 형식대로 답안을 작성하라.",
      "----- OCR TEXT START -----",
      trimmed,
      "----- OCR TEXT END -----"
    ].filter(Boolean).join("\n");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 22000);

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "autononsul-demo"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 1700
      })
    }).finally(() => clearTimeout(timeout));

    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) {
      const t = await resp.text();
      return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: "OpenRouter 응답이 JSON이 아님", detail: t.slice(0, 300) }) };
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content || !content.trim()) {
      return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: "No answer (모델 응답 비어있음)", raw: data }) };
    }

    let answer = content.trim();
    const hasQ1 = answer.includes("[문제 1]");
    const hasQ2 = answer.includes("[문제 2]");
    if (!hasQ1 || !hasQ2) {
      answer = `${prefix ? prefix.trim() + "\n" : ""}[문제 1]\n${answer}\n\n[문제 2]\n(문제 2 답안을 위 텍스트를 바탕으로 이어서 작성하라)`;
    }

    if (prefix && !answer.startsWith(prefix.trim())) {
      answer = `${prefix.trim()}\n${answer}`;
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, answer }) };
  } catch (e) {
    const msg = (e && e.name === "AbortError") ? "OpenRouter 호출 타임아웃" : String(e?.message || e);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: msg }) };
  }
};
