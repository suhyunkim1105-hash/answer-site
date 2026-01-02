// netlify/functions/solve.js

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// ---------------- 유틸 함수 ----------------

// "1: B", "6: 4", "3: n/a" 같은 형식에서 문항별 답 파싱
function parseAnswersFromCompletion(text) {
  const answers = {};
  const lines = text.split('\n');

  // 예: "13: A", "7. 4", "5 : n/a"
  const lineRegex = /^(\d{1,2})\s*[:.]\s*([A-Ea-e1-5]|n\/a|N\/A)/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = lineRegex.exec(line);
    if (!m) continue;

    const qNum = parseInt(m[1], 10);
    const token = m[2].trim();

    // n/a 처리
    if (/^n\/a$/i.test(token)) {
      answers[qNum] = null;
      continue;
    }

    // A~E → 1~5
    if (/^[A-E]$/i.test(token)) {
      const upper = token.toUpperCase();
      answers[qNum] = upper.charCodeAt(0) - 'A'.charCodeAt(0) + 1;
      continue;
    }

    // 숫자 1~5
    const asNum = parseInt(token, 10);
    if (!Number.isNaN(asNum)) {
      answers[qNum] = asNum;
    }
  }

  return answers;
}

// ---------------- OpenRouter 호출 ----------------

async function callModel(ocrText) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }

  const systemPrompt =
    'You are an expert solver for Korean university transfer English exams. ' +
    'You see OCR text of ONE exam page. Extract answers ONLY. ' +
    'For normal multiple-choice questions, answer with letters A–E. ' +
    'For grammar questions that say "Choose one that is either ungrammatical or unacceptable", ' +
    'answer with a NUMBER 1–5 corresponding to the marked part in the sentence. ' +
    'If you are unsure, still choose the single best answer. ' +
    'Output format: one question per line like "3: B" or "7: 4". ' +
    'After all answers, add a line starting with "UNSURE:" listing question numbers you are unsure about (or "-" if none). ' +
    'Finally, on the very last line, output exactly "XURTH".';

  const userPrompt = `OCR_TEXT:\n${ocrText}\n\nNow output ONLY the answers in the required format.`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://beamish-alpaca-e3df59.netlify.app/',
      'X-Title': 'answer-site'
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.1,
      max_tokens: 256
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenRouter error: ${res.status} ${res.statusText} ${errText}`);
  }

  const data = await res.json();
  const completion =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;

  if (!completion) {
    throw new Error('No completion from model');
  }

  return {
    text: completion.trim(),
    model: data.model || 'openai/gpt-4o-mini',
    finishReason:
      data.choices &&
      data.choices[0] &&
      data.choices[0].finish_reason
        ? data.choices[0].finish_reason
        : null
  };
}

// ---------------- Netlify handler ----------------

module.exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ ok: false, error: 'Method Not Allowed' })
      };
    }

    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: 'Invalid JSON body' })
      };
    }

    // 프론트에서 text 또는 ocrText 둘 다 허용
    const rawText = (body.ocrText || body.text || '').trim();
    const page = body.page || null;

    if (!rawText) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: 'Missing ocrText' })
      };
    }

    // 1) 모델 호출
    const modelResult = await callModel(rawText);

    // 2) 모델 답 파싱 (정답표 없이 구조만)
    const parsedAnswers = parseAnswersFromCompletion(modelResult.text);
    const questionNumbers = Object.keys(parsedAnswers)
      .map((n) => parseInt(n, 10))
      .sort((a, b) => a - b);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        text: modelResult.text, // 사람이 읽을 원본
        debug: {
          page,
          questionNumbers,
          answers: parsedAnswers, // { 1:2, 2:1, ... } – 모든 연도 공용
          stopToken: 'XURTH',
          model: modelResult.model,
          finishReason: modelResult.finishReason
        }
      })
    };
  } catch (err) {
    console.error('solve.js error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: err.message || 'Unknown error in solve function'
      })
    };
  }
};
