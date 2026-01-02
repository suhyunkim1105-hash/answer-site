// netlify/functions/solve.js

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ ok: false, error: "Method Not Allowed" }),
    };
  }

  try {
    const { text, page = 1 } = JSON.parse(event.body || "{}");

    if (!text || typeof text !== "string") {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: "Missing or invalid 'text'" }),
      };
    }

    // 1) OCR에서 번호 추출
    const rawNumbers = [];
    const numberRegex = /\b([0-4]?\d)\b/g; // 0~49까지 같은 패턴, 나중에 1~50 필터링
    let match;
    while ((match = numberRegex.exec(text)) !== null) {
      rawNumbers.push(match[1]);
    }

    const normalizedNumbers = Array.from(
      new Set(
        rawNumbers
          .map((n) => parseInt(n, 10))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= 50)
      )
    ).sort((a, b) => a - b);

    // 2) 이 페이지에서 실제로 풀 번호만 선택 (지금은 1~12)
    const numbersForPrompt = normalizedNumbers.filter((n) => n >= 1 && n <= 12);

    if (numbersForPrompt.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          text: "UNSURE: -\nXURTH",
          debug: {
            page,
            rawNumbers,
            normalizedNumbers,
            numbersForPrompt,
            stopToken: "XURTH",
            model: "openai/gpt-4o-mini",
            rawCompletion: "",
          },
        }),
      };
    }

    const stopToken = "XURTH";

    // 3) 프롬프트 (여기서 n/a 절대 쓰지 못하게 막음)
    const systemPrompt = `
You are solving a Korean university English multiple-choice exam.

Task:
- Read the OCR text of a test page.
- The page contains questions identified by numbers (1–50). For the current page, you will only be asked about a subset of these.

Answering rules:
- For EVERY question number I give you, you MUST output EXACTLY ONE choice among A, B, C, D, or E.
- You are NOT allowed to answer "n/a", "N/A", "unknown", "?", or leave any numbered question blank.
- Even if the OCR text is noisy or you are uncertain, you MUST choose the MOST PROBABLE option for each question.
- If you are not confident about a question, still choose the most likely option, and then list that question number in the final UNSURE line.

Output format:
- One line per question, in ascending order of the question numbers I give you, formatted exactly as:
  "<number>: <letter>"
  Example:
  "1: C"
- After all question lines, add exactly one more line:
  "UNSURE: " followed by a comma-separated list of question numbers where you were NOT confident.
  Example:
  "UNSURE: 6, 8, 10"
  If you are confident for all questions, output:
  "UNSURE: -"
- Finally, on the very last line, output the token ${stopToken}.

Do NOT output anything else (no explanations). Only follow the format above.
`.trim();

    const userPrompt = `
OCR TEXT:
${text}

QUESTION NUMBERS TO ANSWER: ${numbersForPrompt.join(", ")}

Remember:
- You MUST choose one of A/B/C/D/E for EVERY question number above.
- You are NOT allowed to use "n/a" for any numbered question.
- Use the UNSURE line only to list question numbers you are uncertain about.
`.trim();

    // 4) OpenRouter 호출
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("Missing OPENROUTER_API_KEY environment variable");
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // 아래 두 개는 OpenRouter 권장 헤더 (원하면 값 바꿔도 됨)
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const textErr = await response.text();
      throw new Error(`OpenRouter error: ${response.status} ${textErr}`);
    }

    const data = await response.json();
    const rawCompletion =
      data.choices?.[0]?.message?.content?.trim() || "";

    // 5) 마지막 줄에 항상 XURTH 붙어 있도록 처리
    let finalText = rawCompletion.trim();
    if (!finalText.includes(stopToken)) {
      // stopToken이 없으면 뒤에 붙여줌
      finalText = finalText.replace(/\s+$/g, "") + `\n${stopToken}`;
    }

    const resultBody = {
      ok: true,
      text: finalText,
      debug: {
        page,
        rawNumbers,
        normalizedNumbers,
        numbersForPrompt,
        stopToken,
        model: "openai/gpt-4o-mini",
        rawCompletion,
      },
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(resultBody),
    };
  } catch (err) {
    console.error("solve function error:", err);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        ok: false,
        error: err.message || "Unknown error",
      }),
    };
  }
};
