// netlify/functions/solve.js

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 25000;

// 너무 길면 타임아웃 확률↑ → 안정성 위해 컷
const MAX_INPUT_CHARS = 4200;

function cutInput(text) {
  text = String(text || "");
  if (text.length <= MAX_INPUT_CHARS) return text.trim();

  const head = text.slice(0, Math.floor(MAX_INPUT_CHARS * 0.6));
  const tail = text.slice(-Math.floor(MAX_INPUT_CHARS * 0.4));
  return (head + "\n\n(중간 생략)\n\n" + tail).trim();
}

// 숫자 유지, 노이즈만 제거(프론트와 동일)
function cleanOcrTextKeepNumbers(s) {
  s = String(s || "");

  s = s.replace(/\r/g, "\n");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/[ \t]*\n[ \t]*/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  s = s.replace(/[A-Za-z]/g, " ");

  s = s.replace(/[^가-힣0-9\s\n\.\,\?\!\:\;\(\)\[\]「」‘’“”\-①②③④⑤⑥⑦⑧⑨⑩]/g, " ");

  s = s.replace(/[ ]{2,}/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.trim();

  return s;
}

const SYSTEM_PROMPT = `
한국어만 사용한다.
마크다운, 불릿(•,-), 번호 목록, 코드블록, 따옴표 장식 금지.
독자에게 말 걸기/메타 멘트/해설/분석/코칭 톤 금지.
"ChatGPT, AI, 프롬프트, 모델, 시스템" 같은 단어를 출력에 절대 쓰지 않는다.

출력은 아래 두 블록만 포함한다. 다른 문장 금지.

[문제 1]
(1번 답안 350~450자)

[문제 2]
(2번 답안 1300~1500자)

문체는 논리적 평서형(~한다/~이다/~로 이해된다/~라고 본다).
제시문은 ①/②/③/④로 지칭하고, 각 사례는 장점+한계를 함께 평가한다.
`.trim();

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Method Not Allowed" }),
      };
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Invalid JSON in request body" }),
      };
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "OPENROUTER_API_KEY is not set in environment" }),
      };
    }

    const ocrTextRaw = (body.ocrText || "").trim();
    const forced = !!body.forced;

    if (!ocrTextRaw) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "ocrText is required" }),
      };
    }

    const cleaned = cleanOcrTextKeepNumbers(ocrTextRaw);
    const trimmed = cutInput(cleaned);

    const userPrompt = `
다음은 OCR로 인식한 고려대 인문계 일반편입 인문논술 시험지 텍스트(제시문+문제 포함)이다.

${trimmed}

위 텍스트에 근거하여, 규칙을 지키며 아래 형식 그대로 답안만 출력하라.

[문제 1]
(1번 답안)

[문제 2]
(2번 답안)
`.trim();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let resp;
    try {
      resp = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
          "X-Title": "autononsul",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: "openrouter/auto",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.4,
          max_tokens: 1800,
          top_p: 0.9,
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    const raw = await resp.text();

    // JSON 파싱 실패(HTML timeout 등) 대비
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: "Upstream returned non-JSON (likely timeout/proxy error)",
          status: resp.status,
          raw: String(raw).slice(0, 2000),
        }),
      };
    }

    const answer =
      data?.choices?.[0]?.message?.content &&
      typeof data.choices[0].message.content === "string"
        ? data.choices[0].message.content.trim()
        : "";

    if (!answer) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          answer: "",
          note: forced
            ? "No answer (forced=true). 입력이 너무 지저분/길어서 모델이 빈 응답을 낼 수 있음"
            : "No answer. 입력을 더 줄이거나 OCR을 더 안정화해 재시도",
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ answer }),
    };

  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? "Upstream timeout (AbortError)"
        : (err?.message || String(err));

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Server error", detail: msg }),
    };
  }
};
