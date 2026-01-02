// netlify/functions/solve.js

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: 'POST only' });
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return json(400, { ok: false, error: 'Invalid JSON body' });
    }

    const ocrText = (body.ocrText || body.text || body.ocr || '').toString();
    const page =
      body.page !== undefined
        ? body.page
        : body.pageNumber !== undefined
        ? body.pageNumber
        : 1;

    if (!ocrText.trim()) {
      return json(400, { ok: false, error: 'Missing OCR text' });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, {
        ok: false,
        error: 'OPENROUTER_API_KEY is not set on the server',
      });
    }

    // MODEL_NAME 환경변수로 모델 바꾸기 (Netlify env key는 "MODEL_NAME")
    const model = (process.env.MODEL_NAME || 'openai/gpt-4.1').toString();

    const systemPrompt = [
      'You are an expert solver for Sungkyunkwan University transfer English exams.',
      '',
      'Input:',
      '- Raw OCR text from ONE page of the exam.',
      '- The text includes section instructions like:',
      '  * "[01-05] Choose one that is either ungrammatical or unacceptable."',
      '  * "[06-10] Choose one that is closest in meaning to the underlined expression."',
      '  * "[11-20] Choose one that is most appropriate for the blank."',
      '',
      'Your job:',
      '1. Carefully read the instructions for each block (e.g. 01-05, 06-10, 11-20).',
      '2. For each question number that appears on this page (1–50), choose EXACTLY ONE best option A–E.',
      '',
      'Very important interpretation of instructions:',
      '- If the instruction says "ungrammatical or unacceptable", choose the ONLY OPTION that is WRONG or UNNATURAL in context.',
      '- If the instruction says "closest in meaning", choose the synonym that best matches the underlined word or phrase.',
      '- If the instruction says "most appropriate for the blank", choose the option that makes the passage most natural and coherent.',
      '',
      'Output format (STRICT):',
      '- One line per question:',
      '  <number>: <letter>',
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
      '- ONLY list question numbers that clearly appear on this page.',
      '- Question numbers are between 1 and 50.',
      '- Use CAPITAL letters A–E only.',
      '- Do NOT output explanations or reasoning.',
      '- Reason internally step by step, but NEVER print your reasoning.',
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

    const completionRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!completionRes.ok) {
      const text = await completionRes.text().catch(() => '');
      return json(502, {
        ok: false,
        error: 'OpenRouter API error',
        status: completionRes.status,
        body: text,
      });
    }

    const completionData = await completionRes.json();
    const choice = completionData.choices && completionData.choices[0];
    const answerText = (choice && choice.message && choice.message.content) || '';

    const parsed = parseAnswers(answerText);

    return json(200, {
      ok: true,
      text: answerText.trim(),
      debug: {
        page,
        model,
        questionNumbers: parsed.questionNumbers,
        answers: parsed.answers,
        ocrTextPreview: ocrText.slice(0, 500),
        finishReason: choice && choice.finish_reason,
        stopToken: 'XURTH',
      },
    });
  } catch (err) {
    console.error('solve.js error:', err);
    return json(500, {
      ok: false,
      error: 'Internal server error in solve function',
      detail: String(err && err.message ? err.message : err),
    });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

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
