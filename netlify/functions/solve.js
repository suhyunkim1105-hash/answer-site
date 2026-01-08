// netlify/functions/solve.js
// 편입영어 객관식 기출 전용 정답 생성 함수
// - 입력: { page, ocrText } (또는 { text })
// - 출력: { ok, text, debug }
//
// env:
//   OPENROUTER_API_KEY  (필수)
//   MODEL_NAME          (선택, 기본: "openai/gpt-4.1")
//   STOP_TOKEN          (선택, 기본: "XURTH")
//   TEMPERATURE         (선택, 기본: 0.1)

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, { ok: false, error: "OPENROUTER_API_KEY is not set" });
    }

    const model = process.env.MODEL_NAME || "openai/gpt-4.1";
    const stopToken = process.env.STOP_TOKEN || "XURTH";
    const temperature = Number(process.env.TEMPERATURE ?? 0.1);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const ocrText = String(body.ocrText || body.text || "").trim();

    if (!ocrText) {
      return json(400, { ok: false, error: "Missing ocrText" });
    }

    // ---- 프롬프트 (모든 기출 공용 방어 프롬프트) ----
    const systemPrompt = `
You are an AI that solves Korean university transfer exam ("편입") English multiple-choice questions.
The input is raw OCR text of the ENTIRE exam page (question numbers, stems, options, sometimes multiple passages).

Your goals, in order:
1) MINIMIZE wrong answers.
2) NEVER skip a visible question number. If a number appears in the text, you MUST output one answer for it.
3) Output ONLY the final answer key, no explanations.

General rules:
- These exams (e.g. Sogang, Hanyang, Sungkyunkwan) are designed with very tricky distractors.
- Do NOT rely on vague intuition like "sounds natural"; instead:
  • For vocab/idiom: choose the option that fits the precise meaning and tone in the sentence.
  • For error identification: find the single most clearly wrong/unnatural underlined part in standard written English.
  • For sentence ordering / paragraph logic: follow discourse markers, pronoun reference, and topic flow carefully.
  • For reading comprehension: base your answer ONLY on the passage; ignore outside knowledge.
- When two options both look plausible, prefer the one that:
  • has stronger support from the exact wording of the passage, and
  • does NOT introduce new information or hidden assumptions.

Output format (VERY IMPORTANT):
- One line per question, strictly in ascending order.
- Each line: "N: X"
  • N = question number (integer, exactly as in the exam: 1, 2, 3, ..., 40)
  • X = option letter (A, B, C, D or A, B, C, D, E depending on the problem)
- Do NOT output Korean.
- Do NOT output explanations, reasons, or any other text.
- Do NOT output blank lines.
- If you are uncertain, you MUST still pick the single most probable option and output it in this format.
- Do NOT print "UNSURE" or anything similar.
`.trim();

    const userPrompt = `
Below is OCR text from a Korean transfer exam English test page.
First, carefully read the ENTIRE text and identify all question numbers.
Then, solve every question and output ONLY the answer key.

Remember:
- Use the exam context and passage content.
- Be extremely careful with fine semantic differences.
- Do NOT skip any visible question numbers.
- Follow the exact "N: X" format, one per line, in ascending order.

OCR TEXT START
${ocrText}
OCR TEXT END
`.trim();

    const url = "https://openrouter.ai/api/v1/chat/completions";

    const payload = {
      model,
      temperature,
      max_tokens: 512, // 답안만 필요하므로 짧게
      stop: [stopToken],
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site-solve",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      return json(502, {
        ok: false,
        error: "OpenRouter error",
        raw: JSON.stringify(data),
      });
    }

    const choice = data.choices && data.choices[0];
    const content =
      choice && choice.message && typeof choice.message.content === "string"
        ? choice.message.content.trim()
        : "";

    if (!content) {
      return json(500, {
        ok: false,
        error: "Empty answer from model",
        dataPreview: JSON.stringify(data).slice(0, 500),
      });
    }

    return json(200, {
      ok: true,
      text: content,
      debug: {
        page,
        model,
        finishReason: choice.finish_reason || choice.native_finish_reason || null,
      },
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
};




