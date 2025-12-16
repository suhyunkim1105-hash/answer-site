// netlify/functions/solve.js
// 안정성 우선: 짧은 프롬프트 + 빠른 모델 고정 + 입력 길이 제한 + 타임아웃/재시도

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function cleanText(s) {
  return (s || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function smartTrim(s, maxChars) {
  if (s.length <= maxChars) return s;
  // 앞+뒤만 남겨서 문제/논제(끝부분에 많음)도 살린다
  const head = s.slice(0, Math.floor(maxChars * 0.55));
  const tail = s.slice(-Math.floor(maxChars * 0.35));
  return `${head}\n...\n${tail}`;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, body: "Invalid JSON" };
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: "OPENROUTER_API_KEY is not set (Netlify env var required)" };
    }

    const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

    const rawOcr = (body.ocrText || "").toString();
    const ocrText = cleanText(rawOcr);
    if (!ocrText) return { statusCode: 400, body: "ocrText is required" };

    // 504 방지: 입력 줄이기(너무 길면 100% 터진다)
    const MAX_CHARS_1 = 4200;
    const MAX_CHARS_2 = 3000; // 재시도 시 더 줄임

    const systemPrompt = cleanText(`
너는 “고려대 인문계 일반편입 인문논술 상위 1% 답안만 쓰는 전용 작성자”다.
규칙:
- 한국어만 사용한다.
- 출력은 정확히 아래 두 블록만 포함한다.
[문제 1]
(답안)
[문제 2]
(답안)
- 두 블록 밖의 문장, 해설/분석/메타 멘트, 목록/번호/마크다운 금지.
- [문제 1]은 350~450자, [문제 2]는 1300~1500자 분량을 목표로 한다.
- 과한 수사 없이 논리/개념/구조 중심으로 실제 시험 답안처럼 쓴다.
`.trim());

    // userPrompt도 길이 최소화(여기 길면 504 확률↑)
    const makeUserPrompt = (trimmed) => cleanText(`
다음은 OCR로 인식한 “제시문+문제” 텍스트다. 이를 바탕으로 답안을 작성하라.

[OCR]
${trimmed}

출력은 반드시:
[문제 1]
...
[문제 2]
...
만 포함하라.
`.trim());

    async function callOnce(trimmed, maxTokens) {
      const controller = new AbortController();
      const timeoutMs = 9000; // Netlify 환경에서 길게 잡아봐야 소용없음(안정성 우선)
      const t = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const resp = await fetch(OPENROUTER_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
            "X-Title": "autononsul",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: makeUserPrompt(trimmed) },
            ],
            temperature: 0.2,
            max_tokens: maxTokens,
          }),
        });

        const text = await resp.text();

        // HTML(Timeout) 등 그대로 반환
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          return { ok: false, status: resp.status, raw: text };
        }

        const answer =
          data?.choices?.[0]?.message?.content &&
          typeof data.choices[0].message.content === "string"
            ? data.choices[0].message.content.trim()
            : "";

        if (!answer) {
          return { ok: false, status: resp.status, raw: "No answer from model" };
        }

        return { ok: true, status: 200, raw: answer };
      } finally {
        clearTimeout(t);
      }
    }

    // 1차 시도
    const trimmed1 = smartTrim(ocrText, MAX_CHARS_1);
    let r = await callOnce(trimmed1, 1400);

    // 실패하면 2차(더 줄여서)
    if (!r.ok) {
      const trimmed2 = smartTrim(ocrText, MAX_CHARS_2);
      r = await callOnce(trimmed2, 1100);
    }

    if (!r.ok) {
      return {
        statusCode: 504,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body:
          typeof r.raw === "string"
            ? r.raw
            : "Upstream error / timeout. Try reducing OCR text.",
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: r.raw,
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "Server error: " + (err?.message || String(err)),
    };
  }
};
