// netlify/functions/solve.js

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Method Not Allowed" };
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Invalid JSON" };
    }

    const ocrText = String(body.ocrText || body.ocr_text || "").trim();
    if (!ocrText) {
      return { statusCode: 400, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "ocrText is required" };
    }

    // ✅ 입력을 줄여서 속도 확보 (너무 길면 무조건 타임아웃 위험)
    const MAX_CHARS = 3500;
    const trimmed = ocrText.length > MAX_CHARS ? ocrText.slice(0, MAX_CHARS) : ocrText;

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "OPENROUTER_API_KEY is not set" };
    }

    // ✅ “무조건 빨리” 나오는 프롬프트 (분량도 줄임)
    const SYSTEM_PROMPT = `
너는 고려대 인문계 일반편입 인문논술 답안을 빠르게 작성하는 AI다.
규칙:
- 한국어만.
- 목록/불릿/번호/마크다운/메타코멘트 금지.
- 출력은 딱 두 블록만.

[문제 1]
(250~330자)

[문제 2]
(700~900자)
`.trim();

    const USER_PROMPT = `
다음은 OCR로 인식된 시험지 텍스트이다.

${trimmed}

위 텍스트를 바탕으로 규칙을 지키며 [문제 1], [문제 2] 답안만 작성하라.
`.trim();

    // ✅ OpenRouter 요청 타임아웃 강제 (무한 대기 방지)
    const controller = new AbortController();
    const timeoutMs = 14000; // 14초 안에 끝내기
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp;
    try {
      resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
          "X-Title": "autononsul-fast"
        },
        body: JSON.stringify({
          model: "openrouter/auto",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: USER_PROMPT }
          ],
          temperature: 0.4,
          max_tokens: 900
        })
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = (e && e.name === "AbortError")
        ? "모델 응답이 늦어서 타임아웃(입력을 더 줄이거나 다시 시도)"
        : ("요청 실패: " + String(e && e.message ? e.message : e));
      return { statusCode: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: msg };
    } finally {
      clearTimeout(timer);
    }

    const raw = await resp.text();

    // ✅ JSON 아닐 수도 있으니 그대로 방어
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { statusCode: resp.status || 200, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: raw };
    }

    const answer =
      data?.choices?.[0]?.message?.content && typeof data.choices[0].message.content === "string"
        ? data.choices[0].message.content.trim()
        : "";

    if (!answer) {
      return { statusCode: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "No answer (모델 응답 비어있음). 입력을 더 줄여서 다시 시도." };
    }

    return { statusCode: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: answer };

  } catch (err) {
    return { statusCode: 500, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Server error: " + String(err && err.message ? err.message : err) };
  }
};

