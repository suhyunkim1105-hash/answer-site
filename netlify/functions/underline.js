// netlify/functions/underline.js
// 비전 모델로 "밑줄 친 부분" 텍스트를 보조 추출.
// (주의) OPENROUTER_VISION_MODEL은 반드시 "이미지 입력 가능한 모델"이어야 함.

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST,OPTIONS",
    },
    body: JSON.stringify(obj),
  };
}

function extractFirstJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  const candidate = s.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch { return null; }
}

async function openrouterVision({ apiKey, model, imageDataUrl, prompt, maxTokens = 700 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageDataUrl } }
            ]
          }
        ]
      }),
      signal: controller.signal,
    });

    const status = resp.status;
    const data = await resp.json().catch(() => null);
    if (!resp.ok) return { ok:false, status, error: data || { message:"OpenRouter HTTP error" } };
    const content = data?.choices?.[0]?.message?.content || "";
    return { ok:true, status, content };
  } catch (e) {
    return { ok:false, status:0, error: String(e && (e.message || e)) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method Not Allowed" });

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_VISION_MODEL;

  if (!apiKey) return json(500, { ok:false, error:"Missing OPENROUTER_API_KEY env" });
  if (!model) return json(500, { ok:false, error:"Missing OPENROUTER_VISION_MODEL env" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok:false, error:"Bad JSON body" }); }

  const imageDataUrl = body.imageDataUrl;
  const questionNumbers = Array.isArray(body.questionNumbers) ? body.questionNumbers : [];
  const hintText = String(body.hintText || "").slice(0, 4000);

  if (!imageDataUrl || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
    return json(400, { ok:false, error:"Missing imageDataUrl" });
  }
  if (questionNumbers.length === 0) return json(400, { ok:false, error:"Missing questionNumbers" });

  const prompt = [
    "You are extracting UNDERLINED text from a photographed English multiple-choice exam page.",
    "I will give you the question numbers to target.",
    "Return ONLY valid JSON. No extra text.",
    "JSON format: {\"13\":\"<underlined phrase>\",\"14\":\"<underlined phrase>\"}.",
    "If a question's underlined part is not visible, return empty string for that number.",
    "Use the provided OCR hint text ONLY to locate the question; rely on the image for underline.",
    `Target question numbers: ${questionNumbers.join(", ")}`,
    "OCR hint text (may be imperfect):",
    hintText
  ].join("\n");

  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await openrouterVision({ apiKey, model, imageDataUrl, prompt, maxTokens: 700 });
    if (!r.ok) {
      if (attempt === 4) return json(502, { ok:false, error:"OpenRouter vision failed", detail: r });
      continue;
    }

    const obj = extractFirstJsonObject(r.content);
    if (!obj) {
      if (attempt === 4) return json(502, { ok:false, error:"Vision model did not return JSON", head: String(r.content).slice(0, 220) });
      continue;
    }

    const underlined = {};
    for (const n of questionNumbers) {
      const key = String(n);
      underlined[key] = String(obj[key] || "").trim();
    }

    return json(200, { ok:true, underlined });
  }

  return json(502, { ok:false, error:"Unexpected underline exit" });
}

