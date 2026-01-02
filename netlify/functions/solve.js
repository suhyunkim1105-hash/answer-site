// Netlify Function: /.netlify/functions/solve
// 한 페이지 이미지(base64)를 받아서
// 1) OCR.Space로 텍스트 인식
// 2) 문항 파싱 & 품질 체크
// 3) 필요하면 재촬영 요청(reshoot)
// 4) GPT-5.1으로 정답 생성 (페이지당 한 번만 호출)

const MAX_RETRY = 2; // 같은 페이지 최대 재촬영 요청 횟수

const {
  OPENROUTER_API_KEY,
  MODEL_NAME = 'openai/gpt-5.1',
  MAX_OUTPUT_TOKENS = '1200',
  OCR_SPACE_API_KEY,
  OCR_SPACE_ENDPOINT,
  STOP_TOKEN = 'XURTH',
  TEMPERATURE = '0.1',
} = process.env;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------- 1. OCR 결과에서 문항 구조 파싱 ----------

function parseQuestionsFromText(text) {
  const questions = [];
  const badQuestions = [];

  if (!text || !text.trim()) {
    return { questions, badQuestions };
  }

  const normalized = text.replace(/\r\n/g, '\n');

  // "1) ..." ~ 다음 번호 전까지를 하나의 블록으로 잡는다.
  const questionRegex =
    /(?:^|\n)\s*(\d{1,3})\s*[\).\]]\s*([\s\S]*?)(?=(?:\n\s*\d{1,3}\s*[\).\]])|$)/g;

  let qMatch;
  while ((qMatch = questionRegex.exec(normalized)) !== null) {
    const number = parseInt(qMatch[1], 10);
    const block = qMatch[2].trim();

    // 보기: "A. ...", "B) ..." 형태
    const optionRegex =
      /(?:^|\n)\s*([A-E])\s*[\).]\s*([\s\S]*?)(?=(?:\n\s*[A-E]\s*[\).])|$)/g;

    const options = {};
    let firstOptionPos = null;
    let oMatch;

    while ((oMatch = optionRegex.exec(block)) !== null) {
      const letter = oMatch[1];
      const optText = (oMatch[2] || '').trim();
      options[letter] = optText;
      if (firstOptionPos === null) firstOptionPos = oMatch.index;
    }

    let stem = block;
    if (firstOptionPos !== null) {
      stem = block.slice(0, firstOptionPos).trim();
    }

    questions.push({
      number,
      stem,
      options,
      rawBlock: block,
    });

    const optionKeys = Object.keys(options);

    // 보기 개수가 2개 미만이면 "이상하게 인식된 문항"으로 간주
    if (optionKeys.length < 2) {
      badQuestions.push(number);
    }
  }

  return { questions, badQuestions };
}

// ---------- 2. OCR.Space 호출 ----------

async function callOcrSpace(base64Image) {
  if (!OCR_SPACE_API_KEY || !OCR_SPACE_ENDPOINT) {
    throw new Error(
      'OCR_SPACE_API_KEY 또는 OCR_SPACE_ENDPOINT 환경변수가 설정되지 않았습니다.',
    );
  }

  const params = new URLSearchParams();
  params.append('apikey', OCR_SPACE_API_KEY);
  params.append('base64Image', base64Image);
  params.append('language', 'eng');
  params.append('isOverlayRequired', 'false');
  params.append('OCREngine', '2');

  const response = await fetch(OCR_SPACE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `OCR 요청 실패: ${response.status} ${response.statusText} - ${text}`,
    );
  }

  const data = await response.json();

  if (data.IsErroredOnProcessing) {
    const msg = data.ErrorMessage || data.ErrorDetails || '알 수 없는 OCR 오류';
    throw new Error(`OCR 처리 오류: ${JSON.stringify(msg)}`);
  }

  const parsedText =
    data.ParsedResults &&
    data.ParsedResults[0] &&
    data.ParsedResults[0].ParsedText;

  if (!parsedText || !parsedText.trim()) {
    throw new Error('OCR 결과에서 텍스트를 찾지 못했습니다.');
  }

  return parsedText;
}

// ---------- 3. OpenRouter(GPT-5.1) 호출 ----------

async function callChatForAnswers(pageText, questionNumbers, lowConfidenceQuestions) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY 환경변수가 설정되지 않았습니다.');
  }

  const model = MODEL_NAME || 'openai/gpt-5.1';
  const maxTokens = parseInt(MAX_OUTPUT_TOKENS, 10) || 1200;
  const temperature = parseFloat(TEMPERATURE) || 0.1;

  const lowConfLine =
    lowConfidenceQuestions && lowConfidenceQuestions.length
      ? `다음 번호는 OCR 인식이 불완전해서 정답 신뢰도가 낮다: ${lowConfidenceQuestions.join(
          ', ',
        )}. 정답 목록을 모두 출력한 뒤, 마지막에서 두 번째 줄에 "※ 다음 문항은 OCR 인식이 불안해서 정답 신뢰도가 낮습니다: ${lowConfidenceQuestions.join(
          ', ',
        )}" 문장을 한국어로 그대로 추가해.`
      : '모든 문항은 정상적으로 인식되었다. 추가 코멘트는 필요 없다.';

  const systemPrompt = `너는 한국 편입 영어 객관식 문제를 푸는 AI 채점 도우미다.
- 사용자는 시험지 전체를 페이지 단위로 촬영해서 OCR 한 텍스트를 보낸다.
- 각 문항은 번호와 보기 (A~E 등 알파벳)으로 주어진다.
- 네 역할은 각 번호별로 정답 선택지의 알파벳만 골라서 알려주는 것이다.
- 해설, 번역, 여분의 문장은 쓰지 마라.
- 출력 형식은 오직 '번호: 알파벳' 한 줄씩이다. 예: '1: C'.
- 보기가 4개이든 5개이든, 항상 보기 중 하나만 골라라.
- 모호하거나 OCR 오류가 있어도, 가장 그럴듯한 보기를 반드시 하나 선택해야 한다.
- 마지막 줄에는 반드시 '${STOP_TOKEN}'만 단독 줄로 출력해라. 다른 기호나 공백을 붙이지 마라.`;

  const userPrompt = `다음은 편입 영어 시험지 한 페이지를 OCR로 인식한 결과야.
이 페이지에 포함된 문항 번호: ${questionNumbers.join(', ')}

[OCR 텍스트 시작]
${pageText.trim()}
[OCR 텍스트 끝]

위 텍스트를 기준으로, 나열된 번호 각각에 대해 한 줄에 '번호: 보기알파벳' 형식으로만 정답을 알파벳으로 적어.
예시: '3: B'
번호는 반드시 위에 나열된 번호만 사용해.
${lowConfLine}

출력 형식을 다시 정리하면:
1) 각 줄은 '번호: 알파벳' 형식
2) 정답 줄들을 모두 출력한 뒤, (필요하다면) 신뢰도 낮은 문항 안내 문장을 한 줄 추가
3) 마지막 줄에는 '${STOP_TOKEN}'만 적을 것.`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://beamish-alpaca-e3df59.netlify.app',
      'X-Title': 'autonnonsul-mcq-solver',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `OpenRouter 요청 실패: ${response.status} ${response.statusText} - ${text}`,
    );
  }

  const data = await response.json();
  const content =
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;

  if (!content) {
    throw new Error('모델 응답에서 content를 찾지 못했습니다.');
  }

  return content.trim();
}

// ---------- 4. Netlify handler ----------

module.exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'POST 메서드만 지원합니다.' }),
    };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const { imageBase64, retryCount: rawRetryCount, pageNumber } = body;

    if (!imageBase64) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'imageBase64 필드가 필요합니다.' }),
      };
    }

    const retryCount = Number.isInteger(rawRetryCount) ? rawRetryCount : 0;

    // 1) OCR
    const ocrText = await callOcrSpace(imageBase64);

    // 2) 문항 파싱 & 품질 체크
    const { questions, badQuestions } = parseQuestionsFromText(ocrText);
    const questionNumbers = questions.map((q) => q.number);

    // 문항이 하나도 안 잡힌 경우 -> 먼저 재촬영 요청
    if (questionNumbers.length === 0 && retryCount < MAX_RETRY) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          status: 'reshoot',
          reason: 'NO_QUESTIONS_DETECTED',
          pageNumber,
          retryCount,
          badQuestions: [],
          messageForUser:
            '이 페이지의 글자가 거의 인식되지 않았어요. 흔들리지 않게, 조금 더 밝고 가깝게 다시 한 번 찍어 주세요.',
        }),
      };
    }

    // 일부 문항 인식이 의심스러운 경우 -> 최대 MAX_RETRY까지 재촬영 유도
    if (badQuestions.length > 0 && retryCount < MAX_RETRY) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          status: 'reshoot',
          reason: 'LOW_CONFIDENCE_QUESTIONS',
          pageNumber,
          retryCount,
          badQuestions,
          messageForUser: `${badQuestions.join(
            ', ',
          )}번 문항 인식이 흐릿해서 잘 안 보여요. 이 페이지를 조금 더 가깝게, 글자가 선명하게 보이도록 다시 찍어 주세요.`,
        }),
      };
    }

    // 재촬영 한계를 넘었으면, 일단 OCR 기반으로 강제 답 생성
    const lowConfidenceQuestions = badQuestions;

    const answersText = await callChatForAnswers(
      ocrText,
      questionNumbers,
      lowConfidenceQuestions,
    );

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        status: 'ok',
        pageNumber,
        questionNumbers,
        lowConfidenceQuestions,
        answersText,
      }),
    };
  } catch (error) {
    console.error('solve 함수 오류:', error);

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        status: 'error',
        message: error.message || '알 수 없는 서버 오류가 발생했습니다.',
      }),
    };
  }
};

