// netlify/functions/solve.js

export async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: cors(), body: "" };
    }
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
    const visionModel = (process.env.OPENROUTER_VISION_MODEL || "").trim();
    const textModel = (process.env.OPENROUTER_MODEL || "").trim();

    if (!apiKey) return json(500, { ok: false, error: "Missing OPENROUTER_API_KEY" });

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { ok: false, error: "Invalid JSON body" }); }

    const page = Number(body.page || 0);
    const ocrText = (body.ocrText || "").toString();
    const imageDataUrl = (body.imageDataUrl || "").toString();

    // 이미지가 있으면 비전 모델 사용
    const useVision = !!imageDataUrl && imageDataUrl.startsWith("data:image");
    const model = useVision ? visionModel : textModel;

    if (!model) {
      return json(500, { ok:false, error: useVision ? "Missing OPENROUTER_VISION_MODEL" : "Missing OPENROUTER_MODEL" });
    }

    const system = [
      "You solve Korean university transfer English multiple-choice exams.",
      "Return ONLY valid JSON. No extra text.",
      "JSON schema: {\"answers\":[{\"q\":number,\"a\":number}]} where a is 1..5 (option number).",
      "Only include questions that are clearly visible in the provided page.",
      "If uncertain, omit that question from answers (do NOT guess).",
      "Underlined parts may be important; use the image to interpret underlines even if OCR text loses them."
    ].join(" ");

    const userText =
      `Page: ${page}\n` +
      `OCR text (may be imperfect):\n` +
      `${ocrText}\n\n` +
      `Task: Identify the questions on this page and output correct option numbers (1..5).`;

    const messages = [
      { role: "system", content: system },
      useVision
        ? {
            role: "user",
            content: [
              { type: "text", text: userText },
              { type: "image_url", image_url: { url: imageDataUrl } }
            ]
          }
        : { role: "user", content: userText }
    ];

    const controller = new AbortController();
    const timeoutMs = 9500; // Netlify 함수 타임아웃 위험 줄이려고 9.5초로 자름
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: 200
      })
    }).catch((e) => { throw e; })
      .finally(() => clearTimeout(timer));

    const raw = await resp.text();
    let data;
    try { data = JSON.parse(raw); }
    catch { return json(502, { ok:false, error:"Upstream non-JSON", detail: raw.slice(0,400) }); }

    if (!resp.ok) {
      return json(resp.status, { ok:false, error:"OpenRouter error", detail: data?.error?.message || raw.slice(0,400) });
    }

    const content = data?.choices?.[0]?.message?.content || "";
    const parsed = safeJson(content);

    if (!parsed || !Array.isArray(parsed.answers)) {
      return json(502, { ok:false, error:"Bad model output", detail: String(content).slice(0,400) });
    }

    // 정규화
    const answers = parsed.answers
      .map(x => ({ q: Number(x.q), a: Number(x.a) }))
      .filter(x => Number.isFinite(x.q) && Number.isFinite(x.a) && x.a>=1 && x.a<=5);

    return json(200, { ok:true, answers, raw: content });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("aborted") || msg.includes("AbortError")) {
      return json(504, { ok:false, error:"Solve timeout" });
    }
    return json(500, { ok:false, error:"Server error", detail: msg });
  }
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function json(statusCode, obj) {
  return { statusCode, headers: { ...cors(), "Content-Type":"application/json; charset=utf-8" }, body: JSON.stringify(obj) };
}

// 모델이 JSON만 주게 했지만 혹시 깨지면 JSON만 뽑아냄
function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  const m = String(s).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
