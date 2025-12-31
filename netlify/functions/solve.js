export default async (req, context) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
    }

    const body = await req.json().catch(() => ({}));
    const text = (body?.text ?? body?.ocrText ?? "").toString().trim();
    if (!text) {
      return new Response(JSON.stringify({ error: "text required" }), { status: 400 });
    }

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini"; // 필요하면 바꿔
    if (!OPENROUTER_API_KEY) {
      return new Response(JSON.stringify({ error: "OPENROUTER_API_KEY missing" }), { status: 500 });
    }

    // 시험 풀이 정확도 올리는 핵심: "형식 강제 + 불필요 문장 금지 + 답만"
    const system = `
You are an expert English exam solver.
Return ONLY valid JSON. No explanations.
You must output in this exact shape:
{"answers":{"1":"A","2":"B",...}}

Rules:
- Answers must be A/B/C/D/E only.
- If a question is missing, do not guess. Omit it.
- Use only the provided OCR text; do not invent unseen options.
`;

    const user = `
Solve the multiple-choice exam from the OCR text below.
Important: The OCR may contain symbols like @ © ® •. Ignore those.
Return only the JSON.

[OCR TEXT START]
${text}
[OCR TEXT END]
`;

    const payload = {
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: system.trim() },
        { role: "user", content: user.trim() }
      ],
      temperature: 0.0,
      max_tokens: 800
    };

    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const raw = await r.json();

    if (!r.ok) {
      return new Response(JSON.stringify({ error: raw?.error?.message || "OpenRouter error", raw }), { status: 500 });
    }

    const content = raw?.choices?.[0]?.message?.content ?? "";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // JSON 파싱 실패 시: 내용 그대로 반환 (디버깅)
      return new Response(JSON.stringify({ error: "Model did not return valid JSON", content }), { status: 500 });
    }

    // 최종 형태 정리
    const answers = parsed?.answers || {};
    return new Response(JSON.stringify({ answers }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e?.message || String(e) }), { status: 500 });
  }
};

