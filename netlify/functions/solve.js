// netlify/functions/solve.js
export default async (req, res) => {
  try {
    const body = (await req.json?.()) || {};
    const question = (body.question || "").toString();
    if (!question) return res.status(400).json({ error: "Missing question" });

    const system = `
You are a strict exam solver for English/Korean MCQ and blank/underline questions.
Rules:
- If choices are present like "[CHOICES] 1) ... | 2) ... | 3) ... | 4) ... | 5) ...":
  Return ONLY the single index: 1 or 2 or 3 or 4 or 5. No words, no punctuation, no explanation.
- If the prompt mentions underline/blank ("underlined", "밑줄", "빈칸", "blank"):
  Use the context to choose the best meaning/synonym or fit for the blank.
  If [HINT] is present, consider it only as a hint.
  Still return ONLY the index: 1~5.
- If there are NO choices, return ONLY one short word/phrase (English or Korean).
- Temperature low. Never output anything else.
`;

    const user = `
Question/OCR text:
---
${question}
---

Remember:
- If choices exist: answer ONLY 1/2/3/4/5.
- Otherwise: answer ONLY one short word/phrase.
`;

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
      })
    });

    const j = await r.json();
    if (!r.ok) {
      const msg = j?.error?.message || j?.error || r.statusText;
      return res.status(500).json({ error: msg });
    }
    let answer = (j?.choices?.[0]?.message?.content || "").trim();

    // 혹시 "3) ..." 같이 오면 숫자만 뽑기
    const m = answer.match(/\b([1-5])\b/);
    if (m) answer = m[1];

    return res.status(200).json({ answer });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};

