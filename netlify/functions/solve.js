// netlify/functions/solve.js

const MODEL_NAME = process.env.MODEL_NAME || 'openai/gpt-4.1';

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'POST only' }),
      };
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }),
      };
    }

    // 여러 경우 모두 지원: ocrText / text / ocr
    const ocrText = (body.ocrText || body.text || body.ocr || '').toString();
    const page =
      body.page !== undefined
        ? body.page
        : body.pageNumber !== undefined
        ? body.pageNumber
        : 1;

    if (!ocrText.trim()) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Missing OCR text' }),
      };
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      // 환경변수 안 잡혀 있으면 바로 에러 리턴
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'OPENROUTER_API_KEY is not set on the server',
        }),
      };
    }

    const systemPrompt = [
      'You are an assistant that solves multiple-choice English questions',
      'from Sungkyunkwan University transfer exams.',
      '',
      '- You receive OCR text from a single exam page.',
      '- Questions are numbered 1–50 overall, but each page only contains a subset.',
      '- Each question has exactly 5 options: A, B, C, D, E.',
      '',
      'Your job:',
      '1. Carefully read the OCR text.',
      '2. Detect which question numbers appear on this page.',
      '3. For EACH detected question number, choose exactly ONE best option (A–E).',
      '4. Output ONLY in the strict format described below.',
      '',
      'Important:',
      '- Temperature is effectively zero: always give the most likely answer, not a random one.',
      '- Do NOT output any explanation or reasoning.',
      '- Think step by step silently, but NEVER print your reasoning.',
    ].join('\n');

    const userPrompt = [
      'OCR TEXT (raw, as recognized):',
      '------------------------------',
      ocrText,
      '------------------------------',
      '',
      'Now extract answers for ALL questions that appear in the OCR text.',
      '',
      'Output format (VERY IMPORTANT, FOLLOW EXACTLY):',
      '- One line per question:',
      '  <question_number>: <option_letter>',
      '  Example:',
      '  1: B',
      '  2: A',
      '  3: C',
      '',
      '- After listing all questions, output:',
      '  UNSURE: -',
      '  XURTH',
      '',
      'Rules:',
      '- Only list question numbers that clearly appear on this page.',
      '- The question numbers are between 1 and 50.',
      '- Use CAPITAL letters A–E only.',
      '- Do NOT write anything else.',
    ].join('\n');

    const completionRes = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          temperature: 0,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      }
    );

    if (!completionRes.ok) {
      const text = await completionRes.text().catch(() => '');
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'OpenRouter API error',
          status: completionRes.status,
          body: text,
        }),
      };
    }

    const completionData = await completionRes.json();
    const choice = completionData.choices && completionData.choices[0];
    const answerText =
      (choice && choice.message && choice.message.content) || '';

    const parsed = parseAnswers(answerText);

    const responseBody = {
      ok: true,
      text: answerText.trim(),
      debug: {
        page,
        model: MODEL_NAME,
        questionNumbers: parsed.questionNumbers,
        answers: parsed.answers,
        ocrTextPreview: ocrText.slice(0, 500),
        finishReason: choice && choice.finish_reason,
        stopToken: 'XURTH',
      },
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(responseBody),
    };
  } catch (err) {
    console.error('solve.js error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        error: 'Internal server error in solve function',
        detail: String(err && err.message ? err.message : err),
      }),
    };
  }
};

/**
 * 모델이 뱉은 텍스트에서
 *  "13: B", "44. D" 같은 패턴을 파싱해서
 *  questionNumbers 배열과 answers(문항번호 -> 1~5) 맵을 만든다.
 */
function parseAnswers(text) {
  const questionNumbers = [];
  const answers = {};
  const seen = new Set();

  if (!text || typeof text !== 'string') {
    return { questionNumbers, answers };
  }

  const lineRegex = /(\d{1,2})\s*[:.)]\s*([A-E1-5])/gi;
  let m;
  while ((m = lineRegex.exec(text)) !== null) {
    const qNum = parseInt(m[1], 10);
    if (!Number.isFinite(qNum) || qNum < 1 || qNum > 50) continue;

    let ansToken = m[2].toUpperCase();
    let idx;

    if (/^[1-5]$/.test(ansToken)) {
      idx = parseInt(ansToken, 10);
    } else {
      idx = 'ABCDE'.indexOf(ansToken) + 1; // A->1, B->2, ...
    }
    if (!(idx >= 1 && idx <= 5)) continue;

    if (!seen.has(qNum)) {
      seen.add(qNum);
      questionNumbers.push(qNum);
    }
    answers[qNum] = idx;
  }

  questionNumbers.sort((a, b) => a - b);
  return { questionNumbers, answers };
}
