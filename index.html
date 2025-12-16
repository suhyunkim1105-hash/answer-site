// netlify/functions/solve.js

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, { error: "OPENROUTER_API_KEY가 Netlify 환경변수에 없음" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    const text = (body.text || "").toString();
    const reason = (body.reason || "").toString();

    if (!text.trim()) {
      return json(400, { error: "text가 비어있음" });
    }

    // ✅ 프롬프트는 여기서 바꿔도 됨
    // (지금은 '형식만' 강제. 내용은 OCR 텍스트 기반으로 답안 생성)
    const SYSTEM_PROMPT = `
너는 "연세대학교 사회복지학과 편입 논술 상위권 답안 작성 AI"다.

규칙:
1) 한국어만 사용한다.
2) 출력은 오직 아래 두 블록만 포함한다.
[문제 1]
(문단)
[문제 2]
(문단)
3) 개요/해설/메타코멘트/번호목록/마크다운 금지.
4) 제시문이 부족하거나 OCR이 끊겨도, 가능한 범위에서 '불완전한 입력'을 전제로 가장 안전하게 답한다.
`.trim();

    const USER_PROMPT = `
다음은 OCR로 추출된 시험지 전체 텍스트다. (중복/깨짐/누락 가능)
이 텍스트를 기반으로 [문제 1], [문제 2] 답안을 작성하라.

(추가 정보) solve 호출 이유: ${reason}

OCR_TEXT:
${text}
`.trim();

    const payload = {
      model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: USER_PROMPT }
      ],
      temperature: 0.2,
      max_tokens: 1800
    };

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // 선택(있어도 되고 없어도 됨)
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site"
      },
      body: JSON.stringify(payload)
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return json(resp.status, { error: data?.error || data || "OpenRouter error" });
    }

    const answer =
      data?.choices?.[0]?.message?.content?.toString?.() ??
      "";

    return json(200, { answer });

  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(obj)
  };
}

