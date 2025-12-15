// netlify/functions/solve.js

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// 너무 긴 입력은 모델/함수 시간 터뜨림 → 현실적으로 잘라야 함
const MAX_INPUT_CHARS = 4200; // (공백 포함) 더 길면 timeout 가능성↑

// 모델 응답이 비는 케이스 대비: 1회 재시도
const MAX_RETRY = 1;

// Netlify Functions 타임아웃 대비 (너무 길면 Inactivity Timeout/504 뜸)
const OPENROUTER_TIMEOUT_MS = 22000;

// 핵심 규칙만 압축해서 “빠르게” 동작하게 만든 SYSTEM_PROMPT
// (네가 준 규칙을 최대한 반영하되, 너무 길면 속도/안정성이 떨어져서 압축함)
const SYSTEM_PROMPT = `
지금부터 너는 “고려대 인문계 일반편입 인문논술 상위 1% 답안만 쓰는 전용 AI”다.
너의 유일한 출력은 ‘시험지에 그대로 적을 완성 답안’이다.

절대 규칙:
1) 한국어만 사용한다.
2) 마크다운, 불릿(•,-), 번호 목록, 코드블록, 따옴표 장식 금지.
3) 독자에게 말 걸기/메타 멘트/해설/분석/코칭 톤 금지.
4) "ChatGPT, AI, 프롬프트, 모델, 시스템" 같은 단어를 출력에 절대 쓰지 않는다.
5) 출력은 아래 두 블록만 포함한다. 다른 문장/머리말/끝맺음 코멘트 금지.

[문제 1]
(1번 답안)

[문제 2]
(2번 답안)

분량:
- [문제 1] 400±50자(350~450자)
- [문제 2] 1400±100자(1300~1500자)

문체:
- 단정적·논리적 평서형 (“~한다/~이다/~로 이해된다/~라고 본다”)
- 제시문은 항상 ①/②/③/④로 지칭
- 양면평가 기본값(타당 + 한계)

구조:
- [문제 1]은 ①의 핵심 개념/논지/기준만 압축 정리, 마지막에 “결국 ①은 ~로 이해된다”로 정리.
- [문제 2]는 서론(논제 재진술+핵심축 제시) → 기준 정리(①을 잣대로 압축) → ②/③/④ 각각 (상황요약→개념대입→장점+한계) → 종합 결론(비교 정리+개념 수준 마무리).
`.trim();

// OCR 텍스트에서 “숫자/이상한 기호”를 최대한 제거하고 한국어 중심으로 정리
function sanitizeKoreanOnly(input) {
  const s = String(input || "");

  // 1) 줄 정리
  let t = s.replace(/\r/g, "\n");
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");

  // 2) 숫자 제거
  t = t.replace(/[0-9]/g, "");

  // 3) 영어 제거 (원하면 유지 가능하지만 “방해된다” 했으니 제거)
  t = t.replace(/[A-Za-z]/g, "");

  // 4) 특수문자 대량 제거 (한글/기본문장부호만 남김)
  // 남길 것: 한글, 공백, 줄바꿈, ., , , ?, !, :, ;, (), [], 「」, ‘’, “”
  t = t.replace(/[^가-힣\s\n\.\,\?\!\:\;\(\)\[\]「」‘’“”\-]/g, " ");

  // 5) 공백 정리
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/ *\n */g, "\n");
  t = t.trim();

  return t;
}

function cutInput(text) {
  if (!text) return "";
  if (text.length <= MAX_INPUT_CHARS) return text;
  // 앞부분만 자르면 뒤 논제가 날아갈 수 있어서: 앞/뒤를 섞어 가져감
  const head = text.slice(0, Math.floor(MAX_INPUT_CHARS * 0.6));
  const tail = text.slice(-Math.floor(MAX_INPUT_CHARS * 0.4));
  return (head + "\n\n(중간 생략)\n\n" + tail).trim();
}

async function openrouterCall({ ocrText, apiKey, model }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);

  try {
    const userPrompt = `
다음은 OCR로 인식한 고려대 인문계 일반편입 인문논술 시험지 전체 텍스트(제시문+문제 포함)이다.

${ocrText}

위 텍스트를 바탕으로, 규칙을 지키며 아래 형식 그대로 답안만 출력하라.

[문제 1]
(1번 답안)

[문제 2]
(2번 답안)
`.trim();

    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "autononsul",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: model || "openrouter/auto",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.4,      // 안정성↑
        max_tokens: 1700,      // 너무 크게 주면 timeout↑
        top_p: 0.9,
      }),
    });

    const rawText = await resp.text();

    // OpenRouter가 JSON이 아닌 HTML/텍스트로 죽는 경우 대비
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return {
        ok: false,
        status: resp.status,
        nonJson: true,
        raw: rawText,
      };
    }

    const answer =
      data?.choices?.[0]?.message?.content &&
      typeof data.choices[0].message.content === "string"
        ? data.choices[0].message.content.trim()
        : "";

    return {
      ok: resp.ok,
      status: resp.status,
      answer,
      rawJson: data,
    };
  } finally {
    clearTimeout(timer);
  }
}

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
        body: JSON.stringify({
          error: "OPENROUTER_API_KEY is not set in environment",
        }),
      };
    }

    // body.ocrText만 받도록 하되, 혹시 다른 키로 와도 대응
    const rawInput = (body.ocrText || body.ocr_text || "").trim();
    if (!rawInput) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "ocrText is required" }),
      };
    }

    // 한국어 중심 정리 + 길이 컷
    const cleaned = sanitizeKoreanOnly(rawInput);
    const trimmed = cutInput(cleaned);

    let lastErr = null;

    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      const result = await openrouterCall({
        ocrText: trimmed,
        apiKey,
        model: "openrouter/auto",
      });

      // HTML/Timeout 같은 비정상 응답
      if (!result.ok) {
        if (result.nonJson) {
          // 프론트에서 그대로 보여주기 좋게 JSON으로 감싸서 전달
          return {
            statusCode: 502,
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({
              error: "Upstream returned non-JSON (likely timeout/proxy error)",
              status: result.status,
              raw: String(result.raw || "").slice(0, 2000),
            }),
          };
        }
        lastErr = `Upstream error: status=${result.status}`;
        continue;
      }

      // 모델이 빈 응답을 주는 케이스
      if (!result.answer) {
        lastErr = "No answer (empty content)";
        continue;
      }

      // 성공
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ answer: result.answer }),
      };
    }

    // 재시도까지 실패
    return {
      statusCode: 504,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        error: "Failed to get answer",
        detail: lastErr || "Unknown",
        hint: "입력을 더 줄이거나(촬영 범위 줄이기/중복 제거), OCR 결과를 더 깨끗하게 만든 뒤 재시도",
      }),
    };
  } catch (err) {
    const msg = err && err.name === "AbortError"
      ? "Upstream timeout (AbortError)"
      : (err?.message || String(err));

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Server error", detail: msg }),
    };
  }
};

