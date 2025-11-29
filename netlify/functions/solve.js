// netlify/functions/solve.js

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function (event, context) {
  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Only POST allowed' }),
    };
  }

  if (!OPENROUTER_API_KEY) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing OPENROUTER_API_KEY' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const section = body.section || 'generic';
  const qType   = body.qType || 'generic';
  const passage = body.passage || null;
  const question = body.question || body.prompt || '';

  if (!question || typeof question !== 'string') {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'question text is required' }),
    };
  }

  // --- 프롬프트 구성 ---
  const systemPrompt = `
You are an assistant used for research on English exam questions (similar to TOEFL).
Your job is to solve multiple-choice questions with options 1–5.
You MUST return ONLY a single digit from 1 to 5 as the final answer, with no explanation.
If you are unsure, choose the most reasonable option, but still output only one digit (1~5).
`.trim();

  let userPrompt;

  if (section === 'reading' && passage) {
    userPrompt = `
[Task]
You are solving a READING comprehension multiple-choice question.

[Question Type]
${qType}

[Passage]
${passage}

[Question and Options]
${question}

[Answer Format]
Return ONLY the number (1, 2, 3, 4, or 5) of the correct option.
Do NOT include any words or punctuation. Just a single digit.
`.trim();
  } else {
    // fallback / generic 용
    userPrompt = `
[Task]
You are solving a multiple-choice question with options 1–5.

[Question and Options]
${question}

[Answer Format]
Return ONLY the number (1, 2, 3, 4, or 5) of the correct option.
Do NOT include any words or punctuation. Just a single digit.
`.trim();
  }

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 8,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('OpenRouter error:', resp.status, text);
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'OpenRouter API error',
          status: resp.status,
        }),
      };
    }

    const data = await resp.json();
    const raw = (data.choices?.[0]?.message?.content || '').trim();

    // 첫 번째 1~5 숫자만 뽑기
    const match = raw.match(/[1-5]/);
    const answer = match ? match[0] : raw; // 혹시 못 뽑으면 raw 그대로 반환

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ answer }),
    };
  } catch (err) {
    console.error('solve.js error', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Internal error', detail: String(err) }),
    };
  }
};
