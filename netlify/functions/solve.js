// netlify/functions/solve.js

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

// 답안 텍스트 파싱: "1: A" → answers[1] = 1, "UNSURE: 2, 9" → unsure 배열
function parseAnswerText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const questionNumbers = [];
  const answers = {};
  let unsure = [];

  for (const line of lines) {
    // "12: B" / "12 - B" 형식
    const m = line.match(/^(\d+)\s*[:\-]\s*([A-E])\s*$/i);
    if (m) {
      const q = Number(m[1]);
      const opt = m[2].toUpperCase();
      questionNumbers.push(q);
      // A=1, B=2, ... 로 저장 (프론트는 숫자→보기 매핑해서 보여줄 수 있음)
      answers[q] = "ABCDE".indexOf(opt) + 1;
      continue;
    }

    // "UNSURE: 2, 7, 13" 형식
    const u = line.match(/^UNSURE\s*:\s*(.*)$/i);
    if (u) {
      const tail = u[1].trim();
      if (!tail || tail === "-") {
        unsure = [];
      } else {
        unsure = tail
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n));
      }
    }
  }

  questionNumbers.sort((a, b) => a - b);
  return { questionNumbers, answers, unsure };
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

    const model = process.env.MODEL_NAME || "anthropic/claude-3.7-sonnet";
    const stopToken = process.env.STOP_TOKEN || "XURTH";
    const temperature = Number(process.env.TEMPERATURE ?? 0.1);

    // max_tokens를 너무 크게 두면 402/타임아웃 나서 상한을 걸어둠
    const maxTokensEnv = Number(process.env.MAX_TOKENS || 512);
    const max_tokens = Math.min(Math.max(maxTokensEnv || 512, 128), 2048);

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

    // 방어 프롬프트 (영어) + OCR 원문 붙이기
    const prompt = `
You are an AI for grading Korean university transfer English multiple-choice exams
(especially Sogang / Hanyang type exams). Your only job is to produce the answer key
with MAXIMUM accuracy and ZERO missing questions.

[ROLE]
- Input: One page of an exam as raw OCR text (question numbers, stems, passages,
  choices are all mixed together).
- Output: For each visible question number, you must choose exactly ONE option
  (A/B/C/D/E) and output a clean answer list.

[ABSOLUTE OUTPUT FORMAT RULES]
You MUST follow these rules exactly:

1. One question per line.
2. The format of each line MUST be:

   <number>: <option>

   Examples:
   1: A
   2: D
   3: B

3. After all question lines, there MUST be exactly one final line that starts with:
   UNSURE:

   - If there are uncertain questions, list their numbers separated by commas:
     UNSURE: 2, 7, 13

   - If you are confident about all questions, output:
     UNSURE: -

4. You MUST NOT output anything else.
   - No explanations, no reasoning, no analysis, no translation, no summaries.
   - No markdown, no headings, no quotes, no extra sentences.
   - Only lines of the form "number: option" and the final "UNSURE: ..." line.

[GENERAL RULES]
1. Scan the entire OCR text once and find ALL question numbers that appear
   (e.g. 1., 1), QUESTION 1, 24., 33. etc.).
2. For every visible question number, you MUST output one answer.
   - Even if the text is noisy or incomplete, you must still pick the BEST guess.
   - NEVER skip or omit a question if its number is visible.
3. Options must ALWAYS be one of A, B, C, D, E (uppercase letters).
   - If the exam uses ①②③④ or 1/2/3/4, map them to A/B/C/D internally.
   - Do NOT output ①②③④ or digits as the final answer, only A/B/C/D/E.
4. OCR errors:
   - Treat obvious OCR noise as the closest valid word from context.
   - Examples: "BLANk" ≈ "BLANK", "bustere" ≈ "austere".
   - Use grammar, meaning, and passage logic to reconstruct as needed.

[TRICK / TRAP AWARENESS – VERY IMPORTANT]
These transfer exams intentionally include very tricky distractors.
You MUST actively defend against the following trap types:

1) Vocabulary / CLOSEST meaning questions
   - Do NOT choose an option just because it is a loose dictionary synonym.
   - Check:
     - The overall tone (positive/negative, sarcastic/serious, praise/criticism).
     - The target (person vs situation vs abstract idea).
     - Strength/degree (mild criticism vs extreme outrage, etc.).
   - Prefer the option that matches the specific nuance and tone in that sentence,
     not just the general definition.
   - Be suspicious of options that are “almost right but slightly off” in tone,
     strength, or typical usage — these are common traps.

2) Sentence ordering / paragraph reordering
   - Carefully reconstruct the logical order:
     - Time sequence: past → later → now → future.
     - Cause → effect.
     - General statement → examples.
     - Problem → explanation → solution or conclusion.
   - Use connectives and pronouns:
     - “However, But, Therefore, Thus, Then, First, Finally, In conclusion”
     - “This, These, Such, They, That war, These novels” etc.
   - A sentence that uses a pronoun or “this/that/these” must come AFTER the
     sentence that introduces its referent.
   - Prefer the order that gives the smoothest, most natural narrative logic,
     not just local transitions.

3) Blank-filling with (a), (b), (c) sets
   - Evaluate ALL blanks in a choice set together.
   - A valid answer must make (a), (b), and (c) ALL sound natural and
     logically consistent with one another and with the passage.
   - If any one of the three positions feels clearly wrong or awkward,
     discard that entire option set.
   - Check that the three words share a coherent level of formality, tone,
     and abstraction.
   - If one option set is “two perfect + one very doubtful” while another
     set is “all three solid and stable”, choose the second set.

4) Inference questions ("LEAST inferred", "MOST likely", "BEST explains")
   - Only accept statements that are clearly supported or strongly implied
     by the passage.
   - Do NOT rely on your own world knowledge beyond what the passage says,
     unless the passage clearly assumes it.
   - For “LEAST inferred”:
     - Identify the options that are directly or strongly supported by the text.
     - Choose the one that is NOT supported, is contradicted, or goes beyond
       what the text justifies.

5) Very similar options with subtle differences
   - When multiple options look very similar, pay special attention to:
     - Positive vs negative connotation.
     - Formal vs informal / technical vs everyday usage.
     - Mild vs extreme intensity.
   - If the passage describes crisis, danger, or strong criticism, prefer options
     that carry an appropriately strong or critical tone.
   - If the passage is neutral/technical, avoid overly emotional or extreme words.

[UNSURE HANDLING]
1. If information is clearly insufficient, or two options remain nearly tied
   even after careful analysis, mark that question as “uncertain”.
2. Even when you are uncertain, you MUST still choose ONE best option and output
   it in the main answer list.
3. At the end, list all such uncertain question numbers after "UNSURE:".
   - Example:
     UNSURE: 2, 9, 12
   - If none are uncertain:
     UNSURE: -

[OVERALL PROCEDURE]
1. Read the entire OCR text and detect all question numbers.
2. For each question, collect its stem, passage (if any), and all choices.
3. Apply the above trap-aware rules to pick ONE best option per question.
4. Output:
   - One line per question: "<number>: <option>"
   - One final line: "UNSURE: ..." as specified above.

Now I will give you the raw OCR text for one page of the exam.
Use ONLY the text below to decide your answers, and follow all the rules above.

---
${ocrText}
---
`;

    const requestPayload = {
      model,
      temperature,
      max_tokens,
      messages: [
        {
          role: "system",
          content:
            "You are a careful assistant that only outputs answers in the specified format.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      stop: [stopToken],
    };

    const completionRes = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          // 아래는 선택이지만, OpenRouter 권장값이라 그대로 둬도 무방
          "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app/",
          "X-Title": "answer-site solve function",
        },
        body: JSON.stringify(requestPayload),
      }
    );

    const completionJson = await completionRes
      .json()
      .catch(() => null);

    if (!completionRes.ok || !completionJson) {
      return json(502, {
        ok: false,
        error: "OpenRouter error",
        raw: completionJson || null,
      });
    }

    const choice =
      completionJson.choices && completionJson.choices[0];
    const content =
      choice &&
      choice.message &&
      typeof choice.message.content === "string"
        ? choice.message.content.trim()
        : "";

    if (!content) {
      return json(502, {
        ok: false,
        error: "Empty answer from model",
        dataPreview: JSON.stringify(completionJson).slice(0, 1000),
      });
    }

    const parsed = parseAnswerText(content);

    const debug = {
      page,
      model,
      questionNumbers: parsed.questionNumbers,
      answers: parsed.answers,
      unsure: parsed.unsure,
      finishReason: choice.finish_reason || "",
      ocrTextPreview: ocrText.slice(0, 400),
    };

    return json(200, {
      ok: true,
      text: content,
      debug,
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "Internal error",
      details: String(err && err.message ? err.message : err),
    });
  }
};



