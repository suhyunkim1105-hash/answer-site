// netlify/functions/solve.js
export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  try {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "서버 설정 오류: OPENROUTER_API_KEY 환경변수가 없습니다." }) };
    }

    const body = JSON.parse(event.body || "{}");
    const ocrText = (body.ocrText || "").trim();
    const target = Number(body.targetCharsPerAnswer || 1000);

    if (!ocrText || ocrText.length < 200) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "ocrText가 너무 짧습니다. OCR이 제대로 되었는지 확인하세요." }) };
    }

    const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

    // 프롬프트는 “길게”가 아니라 “정확하게”가 중요함 (타임아웃/실패 확률↓)
    // 대신: 도표/수치/조건은 절대 누락하지 말라고 강하게 못 박음.
    const system = [
      "너는 연세대학교 사회논술(사회복지 관점 포함) 상위권 답안을 작성하는 AI이다.",
      "사용자가 제공한 OCR 텍스트(제시문/도표/문제)를 근거로만 답한다.",
      "출력은 반드시 아래 형식만 허용한다:",
      "1) [문제 1] 한 문단",
      "2) [문제 2] 한 문단",
      "다른 설명/개요/해설/메타 코멘트/목차/글머리표/마크다운 금지.",
      "각 문단 분량은 목표 글자수에 최대한 맞춘다(너무 짧거나 길면 감점).",
      "도표/그래프/표의 수치나 추세는 반드시 요약해 논증에 연결하되, 없는 수치를 지어내지 마라.",
      "한국어로만 작성한다."
    ].join("\n");

    const user = [
      `목표 분량: 문제1 = 약 ${target}자, 문제2 = 약 ${target}자 (±80자 내).`,
      "아래 OCR 텍스트를 읽고 문제 지시를 충실히 수행하라.",
      "OCR 텍스트:",
      "-----",
      ocrText,
      "-----",
      "주의: OCR이 일부 깨졌을 수 있으니, 명확히 읽히는 정보만 단정하고 애매하면 '제시문에 따르면' 수준으로 처리하라."
    ].join("\n");

    const payload = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.25,
      max_tokens: 1600
    };

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        // 선택 헤더(없어도 됨)
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site"
      },
      body: JSON.stringify(payload)
    });

    const json = await res.json().catch(() => null);

    if (!res.ok || !json) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `OpenRouter 응답 오류(HTTP ${res.status})`, raw: json }) };
    }

    const answer = (json.choices?.[0]?.message?.content || "").trim();

    if (!answer) {
      return { statusCode: 200, headers, body: JSON.stringify({ answer: "", error: "모델 응답이 비어있음" }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ answer }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err?.message || String(err) }) };
  }
}
