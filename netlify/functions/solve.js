export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing OPENROUTER_API_KEY in Netlify env" }) };
    }

    const body = JSON.parse(event.body || "{}");
    const text = (body.text || "").toString().trim();

    if (!text) {
      return { statusCode: 400, body: JSON.stringify({ error: "Empty text" }) };
    }

    // 타임아웃 방지: 입력 너무 길면 뒤쪽만 사용
    const MAX_CHARS = 8500;
    const input = text.length > MAX_CHARS ? text.slice(-MAX_CHARS) : text;

    const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

    const SYSTEM_PROMPT = `
너는 “고려대 인문계 일반편입 인문논술 상위 1% 답안만 쓰는 전용 작성자”다.

규칙:
- 한국어만 사용.
- 출력은 아래 두 블록만. 그 외 문장/해설/메타 금지.
[문제 1]
(답안)
[문제 2]
(답안)

- 마크다운/불릿/번호목록 금지. 순수 문단.
- “AI/모델/프롬프트/시스템” 같은 단어 금지.
- [문제 1] 350~450자, [문제 2] 1300~1500자 분량 감각으로.
- 제시문/논제의 요구를 빠짐없이 수행(요약·비교·평가·견해 포함 여부).
- 논리: 개념→사례→판단, 각 대상은 장점+한계의 양면 평가 기본.
`.trim();

    const USER_PROMPT = `
아래는 OCR로 인식된 고려대 인문논술 “제시문+논제” 전체 텍스트다.
텍스트가 다소 깨져도, 문맥을 최대한 복원해 논제 요구를 충족하는 답안을 작성하라.

[OCR_TEXT]
${input}
`.trim();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 22000); // 22초 내에 끝내기

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 1100,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: USER_PROMPT }
        ]
      })
    });

    clearTimeout(timeout);

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { statusCode: resp.status, body: JSON.stringify({ error: "Upstream error", detail: data }) };
    }

    const answer = (data?.choices?.[0]?.message?.content || "").trim();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ answer })
    };

  } catch (e) {
    // AbortError(타임아웃)도 여기로 온다
    return { statusCode: 504, body: JSON.stringify({ error: "Server error", detail: String(e) }) };
  }
}

