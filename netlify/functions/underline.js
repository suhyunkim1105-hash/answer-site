// netlify/functions/underline.js
// 밑줄(underlined expression)만 "사진을 보고" 추출한다.
// 입력: { imageDataUrl, questionNumbers: [6,7,...], hintText(optional) }
// 출력: { ok:true, underlined: { "6":"...", "7":"..." } }

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { ok:false, error:"Method Not Allowed" });

    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return json(500, { ok:false, error:"Missing OPENROUTER_API_KEY" });

    const model = process.env.OPENROUTER_VISION_MODEL || process.env.OPENROUTER_MODEL;
    if (!model) return json(500, { ok:false, error:"Missing OPENROUTER_MODEL (and/or OPENROUTER_VISION_MODEL)" });

    const body = safeJson(event.body);
    const imageDataUrl = body && body.imageDataUrl;
    const questionNumbers = Array.isArray(body && body.questionNumbers) ? body.questionNumbers : [];
    const hintText = String((body && body.hintText) || "").slice(0, 6000);

    if (!imageDataUrl || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
      return json(400, { ok:false, error:"Invalid imageDataUrl" });
    }

    const qNums = questionNumbers.map(n => Number(n)).filter(n => Number.isFinite(n) && n >= 1 && n <= 60);
    if (qNums.length === 0) {
      return json(400, { ok:false, error:"questionNumbers is required" });
    }

    const system = [
      "Return ONLY valid JSON. No extra text.",
      "Output format exactly: {\"underlined\":{\"6\":\"...\",\"7\":\"...\"}}",
      "Keys must be question numbers as strings.",
      "Values must be the EXACT underlined word/phrase as printed. If you can't see one, use an empty string."
    ].join(" ");

    const userText =
      `You are looking at a photo of an English multiple-choice exam page.\n` +
      `Task: For the following question numbers, extract ONLY the underlined expression (the text that is underlined).\n` +
      `Question numbers: ${qNums.join(", ")}\n` +
      `If the page contains multiple underlines, map each underline to the correct question number.\n` +
      `If helpful, here is OCR hint text (may contain errors):\n` +
      hintText;

    // OpenRouter: message.content can be array with text + image_url (OpenAI-compatible)
    const payload = {
      model,
      temperature: 0,
      max_tokens: 220,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: imageDataUrl } }
          ]
        }
      ]
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type":"application/json",
        "authorization": `Bearer ${key}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    if (!resp.ok) {
      const t = await resp.text().catch(()=> "");
      return json(502, { ok:false, error:`OpenRouter HTTP ${resp.status}: ${t.slice(0,200)}` });
    }

    const data = await resp.json().catch(() => null);
    if (!data) return json(502, { ok:false, error:"OpenRouter returned invalid JSON" });

    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") return json(502, { ok:false, error:"Empty model content" });

    const obj = extractJson(content);
    if (!obj || typeof obj !== "object" || !obj.underlined || typeof obj.underlined !== "object") {
      return json(200, { ok:false, error:"Model output is not valid JSON {underlined:{...}}" });
    }

    // 정리: 요청한 q만 유지
    const underlined = {};
    for (const n of qNums) {
      const v = obj.underlined[String(n)];
      underlined[String(n)] = (v == null) ? "" : String(v).trim();
    }

    return json(200, { ok:true, underlined });
  } catch (e) {
    return json(500, { ok:false, error: String(e && (e.message || e)) });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store"
    },
    body: JSON.stringify(obj)
  };
}

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch { return null; }
}

function extractJson(text) {
  const t = String(text).trim();
  const direct = safeJson(t);
  if (direct) return direct;

  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const slice = t.slice(first, last + 1);
    const obj = safeJson(slice);
    if (obj) return obj;
  }
  return null;
}
