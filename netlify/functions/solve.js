// netlify/functions/solve.js
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok:false, error:"Method Not Allowed" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY || "";
    const model = process.env.OPENROUTER_MODEL || "openai/gpt-4.1";

    if (!apiKey) return json(500, { ok:false, error:"Missing OPENROUTER_API_KEY" });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    const text = (body.text || "").toString();

    if (!text || text.trim().length < 200) {
      return json(400, { ok:false, error:"Text too short" });
    }

    // 성대/홍대 편입영어 스타일에 맞춰 “번호→선택지(A-E)”로만 출력시키기
    const system = [
      "You are a meticulous solver for Korean university transfer English multiple-choice exams.",
      "Use ONLY the provided OCR text. Do NOT assume missing passages.",
      "Output must be strict JSON only: {\"answers\": {\"1\":\"A\", \"2\":\"C\", ...}, \"notes\": \"...\"}",
      "If a question is not solvable due to missing text, set its value to \"?\".",
      "Prefer accuracy over completeness."
    ].join(" ");

    const user = [
      "OCR TEXT (may contain page markers like [PAGE 1] ...).",
      "Tasks:",
      "1) Detect all question numbers (e.g., 01-50).",
      "2) For each question, choose the best option A/B/C/D/E based on the text.",
      "3) Return JSON only. No prose outside JSON.",
      "",
      text
    ].join("\n");

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "auto-ocr-solver"
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });

    const raw = await resp.text();
    let data = {};
    try { data = JSON.parse(raw); } catch {
      return json(502, { ok:false, error:"OpenRouter non-JSON response", detail: raw.slice(0, 300) });
    }

    if (!resp.ok) {
      return json(502, { ok:false, error:"OpenRouter HTTP error", detail: data });
    }

    const content = data?.choices?.[0]?.message?.content || "";
    let parsed = null;
    try { parsed = JSON.parse(content); } catch {
      // 모델이 JSON만 내라 했는데도 깨면, 강제로 정리 시도
      return json(502, { ok:false, error:"Model output not JSON", detail: content.slice(0, 500) });
    }

    const answers = parsed?.answers || {};
    const nums = Object.keys(answers)
      .map(k => parseInt(k, 10))
      .filter(n => Number.isFinite(n))
      .sort((a,b)=>a-b);

    // 화면 표시용 텍스트
    const lines = nums.map(n => `${n}번: ${answers[String(n)]}`);
    const answerText = lines.length ? lines.join("\n") : "정답을 추출하지 못했다.";

    // TTS는 너무 길면 앞 20개만
    const ttsLines = nums.slice(0, 20).map(n => `${n}번 ${answers[String(n)]}`);
    const ttsText = ttsLines.length ? `정답 읽는다. ${ttsLines.join(", ")}.` : "정답을 추출하지 못했다.";

    return json(200, {
      ok: true,
      answerText,
      ttsText,
      notes: (parsed?.notes || "").toString().slice(0, 600)
    });

  } catch (e) {
    return json(500, { ok:false, error:"Server error", detail: e?.message || String(e) });
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST,OPTIONS"
    },
    body: JSON.stringify(obj)
  };
}
