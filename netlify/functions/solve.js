// netlify/functions/solve.js
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { question } = JSON.parse(event.body || '{}') || {};
    if (!question || question.trim().length < 5) {
      return json({ answer: '??紐⑤Ⅴ寃좎뒿?덈떎' });
    }

    const system = `?덈뒗 ?몄엯 ?곸뼱 臾몄젣 梨꾩젏湲곕떎.
1) ?ㅼ쭅 ?뺣떟留?異쒕젰(?レ옄???⑥뼱)
2) ?댁꽕/遺??湲덉?
3) ?좊ℓ?섎㈃ "??紐⑤Ⅴ寃좎뒿?덈떎"?쇨퀬留????;

    const payload = {
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: question + "\n?뺣떟? 媛꾨떒??踰덊샇/?⑥뼱濡쒕쭔." }
      ],
      max_tokens: 8,
      temperature: 0
    };

    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) return json({ answer: `OpenRouter ?ㅻ쪟: ${r.status}` });

    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content?.trim() || "??紐⑤Ⅴ寃좎뒿?덈떎";
    const answer = (text.length <= 16) ? text : "??紐⑤Ⅴ寃좎뒿?덈떎";
    return json({ answer });
  } catch (e) {
    return json({ answer: "?먮윭: " + (e?.message || e) });
  }
};

function json(obj) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

