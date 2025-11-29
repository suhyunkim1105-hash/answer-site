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
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Missing OPENROUTER_API_KEY' }),
      };
    }

    const prompt = `
You are solving an English multiple-choice exam question.
The text may include extra lines such as URLs, timestamps, or page numbers.
Ignore any lines that are clearly not part of the exam question or answer choices.

Rules:
- Focus on the main question and the answer choices labeled 1, 2, 3, 4, 5.
- Decide which option (1-5) is the single best answer.
- Output ONLY the number of the correct option: 1, 2, 3, 4, or 5.
- Do NOT output any words, explanations, punctuation, or extra characters. Just one digit.

Here is the OCR text (question + options + possible noise):
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
            content: 'You answer ONLY with a single digit 1-5 (the correct option). Ignore URLs, timestamps, page numbers, and any unrelated text.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 5,
        temperature: 0,
      }),
    });

    const data = await response.json();
    const raw = (data.choices?.[0]?.message?.content || '').trim();

    // 응답에서 1~5 숫자 하나만 뽑기
    const match = raw.match(/[1-5]/);
    const finalAnswer = match ? match[0] : raw;

    return {
      statusCode: 200,
      body: JSON.stringify({ answer: finalAnswer }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server error' }),
    };
  }
};
