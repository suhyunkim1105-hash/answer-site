export default async (req, context) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

  try {
    const body = await req.json();
    const question = (body?.question || '').toString().slice(0, 12000);
    if (!question) return json({ error: 'Missing question' }, 400);

    const apiKey = Deno?.env?.get('OPENROUTER_API_KEY') || process?.env?.OPENROUTER_API_KEY;
    if (!apiKey) return json({ error: 'Missing OPENROUTER_API_KEY' }, 500);

    const sys = `You are an answer-only solver for bilingual (Korean/English) exam questions.
Rules:
- Return ONLY the final answer. No steps.
- Multiple choice: return only the option label (e.g., A).
- Numeric: only the number with essential unit.
- If "지문/Passage" is provided, use it as context and answer only the "문항/Question".
- If there are multiple questions, answer just the one shown.
- If uncertain, choose the most likely single answer (be decisive).`;

    const user = `Input may contain a passage and one question.
If both exist, answer ONLY the question.

${question}

Return ONLY the final answer.`;

    const payload = {
      model: 'openrouter/auto',
      temperature: 0.0,
      top_p: 1,
      max_tokens: 64,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user }
      ]
    };

    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://beamish-alpaca-e3df59.netlify.app',
        'X-Title': 'answer-site v3'
      },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const txt = await r.text();
      return json({ error: 'OpenRouter error', status: r.status, details: txt }, 502);
    }

    const data = await r.json();
    const ans = data?.choices?.[0]?.message?.content?.trim() || '';
    return json({ answer: sanitize(ans) });

  } catch (err) {
    return json({ error: err?.message || 'Server error' }, 500);
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}
function json(obj, status=200){
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
}
function sanitize(s=''){ return s.replace(/\r|\n/g,' ').replace(/\s+/g,' ').trim(); }
