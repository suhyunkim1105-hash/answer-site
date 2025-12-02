// netlify/functions/solve.js
'use strict';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
// 기본 모델을 gpt-5로 사용 (환경변수 OPENROUTER_MODEL이 있으면 그걸 우선)
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-5';

// 단어 수 제한용 유틸
function clampWords(text, maxWords) {
  if (!text) return '';
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(' ') + ' ...';
}

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

목표:
- TOEFL iBT 리딩 객관식 문제를 풀어라.
- OCR_TEXT 안에 지문/문제/선택지가 섞여 있을 수 있다.
- answer 에는 정답 선택지(번호나 글자 등)만 짧게 넣어라. (예: "3", "B")
- detail 에는 핵심 근거/요약만 160단어 이내로 써라. 너무 긴 장문 설명은 피하라.
`;
  } else if (mode === 'listening') {
    taskDesc = `
[MODE] LISTENING

목표:
- TOEFL iBT 리스닝 객관식 문제를 풀어라.
- AUDIO_TEXT 에 대화/강의 스크립트가, OCR_TEXT 에 문제+선택지가 들어 있다고 가정하라.
- answer 에는 정답 선택지(번호나 글자)를 짧게 넣어라.
- detail 에는 근거가 되는 부분을 중심으로 160단어 이내로 설명하라.
`;
  } else if (mode === 'writing') {
    taskDesc = `
[MODE] WRITING

목표:
- TOEFL iBT Writing 문제에 대해 "최고 점수"를 받을 수 있는 모범 에세이를 작성하라.
- OCR_TEXT 에는 통합형 또는 Academic Discussion/독립형 프롬프트가 들어 있다.
- 에세이 길이:
  - 통합형/독립형 구분과 관계없이, 대략 200~250단어를 목표로 하라.
  - 절대 260단어를 넘기지 마라. (길어질 것 같으면 내용을 압축하라.)
- answer 에는 영어 에세이 본문 전체를 넣어라.
- detail 에는 에세이 구조/아이디어를 80단어 이내로 짧게 요약하라.
`;
  } else if (mode === 'speaking') {
    taskDesc = `
[MODE] SPEAKING

목표:
- TOEFL iBT Speaking 문제에 대해 "최고 점수"를 받을 수 있는 모범 스크립트를 작성하라.
- OCR_TEXT (및 필요하면 AUDIO_TEXT)를 참고하여, 실제 사람이 말한다고 가정하라.
- 시간 제약:
  - 사람은 준비/더듬거리는 시간까지 포함해서 45~60초 안에 말해야 한다.
  - 평균 130~160 words/min 정도로 말한다고 가정할 때,
    70~80단어 정도가 40~60초에 해당한다.
  - 따라서 answer 의 길이는 대략 70단어를 목표로 하고,
    절대 80단어를 넘기지 마라.
- answer 에는 영어 스크립트 전체를 넣어라.
- detail 에는 핵심 포인트를 bullet 형식으로 60단어 이내로 요약하라.
`;
  } else {
    taskDesc = `
[MODE] AUTO

목표:
- 입력을 보고 문제 유형을 추론한 뒤, 사람이 바로 쓸 수 있는 "최고의 답"을 생성하라.
- answer 에 핵심 답변을, detail 에 짧은 설명을 넣어라.
- 불필요하게 길게 쓰지 말고 1분 안에 읽을 분량(160단어 이내)을 유지하라.
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
  // 설명 + JSON 섞여 있을 수 있으니, 첫 번째 { ... } 블록만 추출
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

항상 아래 JSON 형식 "하나의 객체만" 응답해야 한다. JSON 외의 텍스트는 절대 쓰지 마라.

JSON 스키마:
{
  "answer": string,     // 사람이 바로 보고 사용할 "최고의 답변" (정답 번호, 선택지, 에세이, 스피킹 스크립트 등)
  "confidence": number, // 0~1 또는 0~100 사이 숫자. 이 answer 가 실제 정답/적절한 답이라고 생각하는 확률.
  "detail": string      // 짧은 이유/근거/구조 요약
}

규칙:
- confidence:
  - 0.0~1.0 또는 0~100 형식으로 줄 수 있다.
  - 예: 0.82 또는 82 는 약 82% 확신.
- 네가 정답에 대한 확신이 0.1 (10%) 미만이라면,
  - "answer": "?"
  - "confidence": 0 또는 0.05 정도
  - "detail"에는 왜 확신이 없는지 간단히 적어라.
- READING/LISTENING:
  - answer 에는 정답 선택지(번호/글자)를 최대한 간결하게 넣어라.
  - detail 은 160단어 이내로 요약하라.
- WRITING:
  - answer 에는 모범 에세이 전체를 넣되, 260단어를 넘기지 않도록 신경 써라.
- SPEAKING:
  - answer 에는 70단어 안팎, 절대 80단어를 넘기지 않는 스크립트를 넣어라.
  - 사람의 실제 말하기 속도(더듬거림 포함)를 고려해서 45~60초 안에 말할 수 있는 분량으로 제한하라.
- 위 규칙을 지키면서도, 항상 "사람이 실제 토플에서 쓸 법한 최고 수준의 답"을 목표로 하라.

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
      parsed = {
        answer: '?',
        confidence: 0,
        detail: '모델 응답 파싱 실패: ' + e.toString()
      };
    }

    let answer = (typeof parsed.answer === 'string') ? parsed.answer.trim() : '?';
    let conf = Number(parsed.confidence);
    if (!Number.isFinite(conf)) conf = 0;

    // 0~1 또는 0~100 둘 다 허용 → 0~100으로 통일
    if (conf <= 1) {
      conf = conf * 100;
    }
    if (conf < 0) conf = 0;
    if (conf > 100) conf = 100;

    let detail = (typeof parsed.detail === 'string') ? parsed.detail : '';

    // --- 모드별 길이 제한 (단어 수 기반) ---
    if (mode === 'speaking') {
      // 스피킹: 최대 80단어 (사람이 45~60초 안에 말할 수 있게)
      answer = clampWords(answer, 80);
      detail = clampWords(detail, 60);
    } else if (mode === 'writing') {
      // 라이팅: 모범 에세이 최대 260단어
      answer = clampWords(answer, 260);
      detail = clampWords(detail, 80);
    } else if (mode === 'reading' || mode === 'listening') {
      // 리딩/리스닝: 해설 길이 제한
      detail = clampWords(detail, 160);
    } else {
      // auto 등 기타 모드
      detail = clampWords(detail, 160);
    }

    // 확신도 10% 미만이면 answer 강제 "?"
    if (conf < 10) {
      answer = '?';
    }

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
