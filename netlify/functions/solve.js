// netlify/functions/solve.js  (Netlify "Response" 반환 방식)
export default async (req) => {
  try {
    const { question } = await req.json();
    if (!question) {
      return new Response(JSON.stringify({ error: "Missing question" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const system = `
You are a strict exam solver for English/Korean MCQ and blank/underline questions.
Rules:
- If choices are present like "[CHOICES] 1) ... | 2) ... | 3) ... | 4) ... | 5) ...":
  Return ONLY one of: 1 or 2 or 3 or 4 or 5. No words, no punctuation, no explanation.
- If the prompt mentions underline/blank ("underlined", "밑줄", "빈칸", "blank"):
  Use the context to choose the best meaning/synonym or fit for the blank.
  If [HINT] is present, consider it only as a hint.
  Still return ONLY the index 1~5.
- If there are NO choices, return ONLY one short word/phrase (English or Korean).
- Temperature low. Never output anything else.
`.trim();

    const user = `
Question/OCR text:
---
${question}
---
Remember:
- If choices exist: answer ONLY 1/2/3/4/5.
- Otherwise: answer ONLY one short word/phrase.
`.trim();

    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.1,
        max_tokens: 8
      }),
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j && (j.error?.message || j.error)) || r.statusText;
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    let answer = (j?.choices?.[0]?.message?.content || "").trim();
    // 혹시 "3) ..." 식이면 숫자만 추출
    const m = answer.match(/\b([1-5])\b/);
    if (m) answer = m[1];

    return new Response(JSON.stringify({ answer }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

