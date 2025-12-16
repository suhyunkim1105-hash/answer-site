export default async (request, context) => {
  try {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
    }

    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      return new Response(JSON.stringify({ error: "Missing OPENROUTER_API_KEY in Netlify env" }), { status: 500 });
    }

    const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini"; // 빠르고 안정 쪽(기본값)
    const body = await request.json().catch(() => ({}));
    let text = (body && body.text) ? String(body.text) : "";

    // 너무 길면 타임아웃 확률 폭증 → 뒤쪽 위주로 자르기
    const MAX = 6500;
    if (text.length > MAX) text = text.slice(text.length - MAX);

    // 빈 입력 방지
    if (!text.trim()) {
      return new Response(JSON.stringify({ answer: "OCR 텍스트가 비어있음" }), { status: 200 });
    }

    // 프롬프트(짧게 + 강제 형식)
    const system = `
너는 “고려대 인문계 일반편입 인문논술 상위 1% 답안만 쓰는 전용 AI”다.
규칙:
1) 한국어만.
2) 출력은 아래 두 블록만. 그 외 문장 금지.
[문제 1]
(답안)
[문제 2]
(답안)
3) 해설/메타/목차/불릿/마크다운/AI 언급 금지.
4) 가능한 한 현실적인 분량:
[문제 1] 350~450자, [문제 2] 1300~1500자.
`.trim();

    const user = `다음 OCR 텍스트는 논술 시험지(제시문+문제)다. 그대로 읽고 규칙대로 답안만 출력하라.\n\n${text}`;

    // OpenRouter 호출(타임아웃 방어)
    const controller = new AbortController();
    const timeoutMs = 25000; // 너무 길면 Netlify/중간망에서 끊김 ↑
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        // 있으면 도움됨(권장)
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 1400,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
      signal: controller.signal
    }).finally(() => clearTimeout(timer));

    const ct = resp.headers.get("content-type") || "";
    const raw = ct.includes("application/json") ? await resp.json() : { _text: await resp.text() };

    if (!resp.ok) {
      return new Response(JSON.stringify({
        error: "Upstream error",
        status: resp.status,
        detail: raw
      }), { status: 502 });
    }

    const answer =
      raw?.choices?.[0]?.message?.content?.trim?.() ||
      "";

    if (!answer) {
      return new Response(JSON.stringify({
        answer: "No answer (모델 응답 비어있음). 입력을 더 줄여서 다시 시도"
      }), { status: 200 });
    }

    // HTML이 섞여 들어오는 경우 방어
    if (answer.includes("<HTML") || answer.includes("Inactivity Timeout")) {
      return new Response(JSON.stringify({
        answer: "서버 타임아웃/HTML 응답 감지. 입력을 더 줄이거나 OPENROUTER_MODEL을 빠른 모델로 바꿔."
      }), { status: 200 });
    }

    return new Response(JSON.stringify({ answer }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  } catch (e) {
    const msg = (e && e.name === "AbortError")
      ? "Upstream timeout (AbortError)"
      : String(e && e.message ? e.message : e);

    return new Response(JSON.stringify({ error: "Server error", detail: msg }), { status: 500 });
  }
};

