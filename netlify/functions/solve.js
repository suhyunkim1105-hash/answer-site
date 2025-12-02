// netlify/functions/solve.js
'use strict';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

async function callOpenRouterChat(messages) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY 환경변수가 설정되지 않았습니다.');
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://beamish-alpaca-e3df59.netlify.app',
      'X-Title': 'answer-site'
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      temperature: 0.2
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenRouter 응답에 content가 없습니다.');
  }
  return content;
}

function buildUserPrompt(mode, ocrText, audioText) {
  const trimmedOcr = (ocrText || '').slice(0, 6000);
  const trimmedAudio = (audioText || '').slice(0, 6000);

  let taskDesc = '';
  if (mode === 'reading') {
    taskDesc = `
[MODE] READING

당신의 목표:
- TOEFL iBT 리딩 객관식 문제를 풀어라.
- OCR_TEXT 안에 지문과 문제, 선택지가 섞여 있을 수 있다.
- 사람에게 보여줄 "최고의 정답"만 answer 필드에 담고, 간단한 영어/한국어 혼합 설명은 detail에 담아라.
- answer에는 보통 정답 선택지 번호나 글자를 담아라 (예: "3", "2", "B").
`;
  } else if (mode === 'listening') {
    taskDesc = `
[MODE] LISTENING

당신의 목표:
- TOEFL iBT 리스닝 객관식 문제를 풀어라.
- AUDIO_TEXT에는 대화/강의 스크립트가, OCR_TEXT에는 문제와 선택지가 포함되어 있다.
- answer에는 정답 선택지(번호 또는 글자)를 담고, detail에 근거 설명을 짧게 써라.
`;
  } else if (mode === 'writing') {
    taskDesc = `
[MODE] WRITING

당신의 목표:
- TOEFL iBT Writing 문제에 대해 "최고 점수"를 받을 수 있는 모범 에세이를 작성하라.
- OCR_TEXT에는 통합형/Academic Discussion 프롬프트가 들어있다.
- answer 필드에 영어 에세이 본문 전체를 작성하라.
- 단어 수는 대략 200~280 단어 사이가 되도록 해라.
- detail에는 에세이의 간단한 구조 요약(한글/영어 혼합 가능)을 짧게 써라.
`;
  } else if (mode === 'speaking') {
    taskDesc = `
[MODE] SPEAKING

당신의 목표:
- TOEFL iBT Speaking 문제에 대해 "최고 점수"를 받을 수 있는 모범 스크립트를 작성하라.
- OCR_TEXT (그리고 필요하면 AUDIO_TEXT)를 참고하여, 말했을 때 45~60초 정도가 되는 답변을 만들어라.
- answer 필드에 영어 스크립트 전체를 작성하라.
- detail에는 핵심 포인트를 bullet 형식으로 짧게 요약하라.
`;
  } else {
    taskDesc = `
[MODE] AUTO

당신의 목표:
- 주어진 정보를 보고 어떤 형태의 문제인지 추론해서 가장 자연스러운 방식으로 답을 생성하라.
- answer에 사람이 바로 보고 사용할 수 있는 "최고의 답변"을 넣고, detail에 짧은 설명을 넣어라.
`;
  }

  return `
${taskDesc}

[입력 데이터]

OCR_TEXT:
${trimmedOcr}

AUDIO_TEXT:
${trimmedAudio}
`.trim();
}

function parseModelJson(text) {
  // 모델이 설명 + JSON을 섞어서 보낼 수도 있으니, 첫 번째 { ... } 블록만 추출 시도
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('JSON 형태를 찾지 못했습니다.');
  }
  const jsonStr = text.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonStr);
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const mode = (body.mode || 'reading').toLowerCase();
    const ocrText = body.ocrText || '';
    const audioText = body.audioText || '';

    const userPrompt = buildUserPrompt(mode, ocrText, audioText);

    const systemMessage = {
      role: 'system',
      content: `
당신은 TOEFL iBT 문제를 대신 풀어주는 AI 조교이다.
항상 아래 JSON 형식으로만 답해야 한다. 다른 텍스트를 JSON 밖에 쓰지 마라.

JSON 스키마:
{
  "answer": string,    // 사람이 바로 보고 사용할 "최고의 답변" (정답 번호, 선택지, 에세이 전체, 스피킹 스크립트 등)
  "confidence": number, // 0~1 또는 0~100 사이의 숫자. 너가 이 answer가 실제로 정답/적절한 답이라고 생각하는 확률.
  "detail": string      // 짧은 이유 설명, 근거, 구조 요약 등
}

규칙:
- confidence는 너의 "실제 정답일 것 같은 확률"을 나타낸다.
  - 예: 0.82 또는 82 는 약 82% 확신.
- 만약 너의 확신이 0.1 (10%) 미만이면, 억지로 찍지 말고:
  - "answer": "?"
  - "confidence": 0 또는 0.05 정도
  - "detail"에는 왜 확신이 없는지 간단히 적어라.
- READING/LISTENING 에서는 보통 answer에 정답 번호 또는 선택지 텍스트만 넣어라.
- WRITING/SPEAKING 에서는 answer에 "모범 에세이/스피킹 스크립트 전체"를 넣어라.
- detail은 너무 길게 쓰지 말고 핵심만 요약하라.

반드시 위 JSON 객체 하나만 응답하라.
      `.trim()
    };

    const userMessage = {
      role: 'user',
      content: userPrompt
    };

    const rawContent = await callOpenRouterChat([systemMessage, userMessage]);

    let parsed;
    try {
      parsed = parseModelJson(rawContent);
    } catch (e) {
      // 파싱 실패 시 안전한 기본값
      parsed = {
        answer: '?',
        confidence: 0,
        detail: '모델 응답 파싱 실패: ' + e.toString()
      };
    }

    let answer = (typeof parsed.answer === 'string') ? parsed.answer.trim() : '?';
    let conf = Number(parsed.confidence);
    if (!Number.isFinite(conf)) conf = 0;

    // 0~1 또는 0~100 양쪽 다 허용 → 0~100으로 정규화
    if (conf <= 1) {
      conf = conf * 100;
    }
    if (conf < 0) conf = 0;
    if (conf > 100) conf = 100;

    // 확신도 10% 미만이면 강제로 "?" 처리 (이중 안전장치)
    if (conf < 10) {
      answer = '?';
    }

    const detail = (typeof parsed.detail === 'string') ? parsed.detail : '';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        mode,
        answer,
        confidence: conf,
        detail
      })
    };
  } catch (e) {
    console.error('solve.js error:', e);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answer: '?',
        confidence: 0,
        detail: '서버 내부 에러: ' + e.toString()
      })
    };
  }
};
