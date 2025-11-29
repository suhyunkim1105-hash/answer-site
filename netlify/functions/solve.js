// netlify/functions/solve.js

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: 'Method Not Allowed',
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const question = (body.question || '').trim();

    if (!question) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'question is required' }),
      };
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      // 환경변수 안 들어가 있으면 무조건 여기서 막힘
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Missing OPENROUTER_API_KEY' }),
      };
    }

    const prompt = `
You are solving an English multiple-choice exam question.

The text includes a question and 5 answer options labeled 1, 2, 3, 4, 5.

Rules:
- Carefully read the question and all 5 options.
- Decide which single option (1-5) is the best answer.
- Output ONLY the number of the correct option: 1, 2, 3, 4, or 5.
- Do NOT output any words, punctuation, or explanations. Just one digit.

Here is the exam text (question + options):
${question}
`.trim();

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You answer ONLY with a single digit 1-5 (the correct option). No explanation. No extra characters.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 5,
        temperature: 0,
      }),
    });

    const data = await response.json();

    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
      ? data.choices[0].message.content
      : ''
    ).trim();

    // 응답에서 1~5 숫자 하나만 뽑기
    const match = raw.match(/[1-5]/);
    const finalAnswer = match ? match[0] : raw || '';

    return {
      statusCode: 200,
      body: JSON.stringify({ answer: finalAnswer }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server error', detail: err.message }),
    };
  }
};
