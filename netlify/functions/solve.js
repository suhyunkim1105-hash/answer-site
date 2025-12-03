// netlify/functions/solve.js

// Netlify Node 18+ 에서는 fetch 가 기본 제공됨.

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod !== "POST") {
      return textResponse(200, "[ERROR] Use POST with JSON body.");
    }

    const body = safeParseJSON(event.body);
    const modeRaw = (body.mode || "auto").toString().toLowerCase();
    const ocrText = (body.ocrText || "").toString();
    const audioText = (body.audioText || "").toString();

    const mode = ["reading", "listening", "writing", "speaking"].includes(modeRaw)
      ? modeRaw
      : "auto";

    // 완전 빈 입력 방지
    if (!ocrText.trim() && !audioText.trim()) {
      return textResponse(
        200,
        "[ERROR] OCR 텍스트와 음성 텍스트가 모두 비어 있습니다. 화면을 조금 더 크게/가깝게 찍거나, STT가 켜져 있는지 확인하세요."
      );
    }

    const model = process.env.OPENROUTER_MODEL || "gpt-4.1-mini";
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_TOKEN;

    if (!apiKey) {
      return textResponse(
        200,
        "[ERROR] OPENROUTER_API_KEY 환경변수가 설정되어 있지 않습니다."
      );
    }

    // 모드별 프롬프트 구성
    const messages = buildMessages({
      mode,
      ocrText,
      audioText,
    });

    const openRouterRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        // 선택: OpenRouter 권장 헤더 (없어도 동작은 함)
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site-toefl-helper"
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: 900, // 너무 길어지지 않게 제한
      }),
    });

    if (!openRouterRes.ok) {
      const errText = await safeReadText(openRouterRes);
      return textResponse(
        200,
        `[ERROR] OpenRouter HTTP 오류 (status=${openRouterRes.status}).\n${truncate(errText, 800)}`
      );
    }

    const data = await openRouterRes.json().catch(() => null);
    const content =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;

    if (!content || typeof content !== "string") {
      return textResponse(
        200,
        "[ERROR] OpenRouter에서 비어 있는 응답을 받았습니다."
      );
    }

    // 항상 순수 텍스트로 반환 (HTML 절대 X)
    return textResponse(200, content);
  } catch (err) {
    console.error("solve.js top-level error:", err);
    return textResponse(
      200,
      `[ERROR] solve 함수 내부 예외: ${(err && err.message) || String(err)}`
    );
  }
};

// ----------------- 유틸 함수들 -----------------

function textResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: typeof body === "string" ? body : String(body),
  };
}

function safeParseJSON(str) {
  try {
    return JSON.parse(str || "{}");
  } catch {
    return {};
  }
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(text, maxLen) {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n...[truncated]...";
}

// ----------------- 프롬프트 구성 -----------------

function buildMessages({ mode, ocrText, audioText }) {
  const cleanOcr = ocrText.trim();
  const cleanAudio = audioText.trim();

  const combinedContextParts = [];
  if (cleanOcr) {
    combinedContextParts.push("=== OCR TEXT (화면에서 인식된 내용) ===\n" + cleanOcr);
  }
  if (cleanAudio) {
    combinedContextParts.push("=== AUDIO/STT TEXT (음성 인식 내용) ===\n" + cleanAudio);
  }
  const combinedContext = combinedContextParts.join("\n\n");

  const baseSystem = {
    role: "system",
    content:
      "You are an expert TOEFL iBT tutor and solver. " +
      "You see noisy OCR text from the screen and/or a rough STT transcript from the audio. " +
      "You must infer the actual TOEFL-style question and provide the best possible answer. " +
      "Always follow the requested output format exactly. " +
      "Never add extra sections or headings that are not requested."
  };

  if (mode === "reading" || mode === "listening" || mode === "auto") {
    const sectionLabel = mode === "listening" ? "LISTENING" : "READING";
    return [
      baseSystem,
      {
        role: "user",
        content:
          `Mode: ${sectionLabel}\n` +
          "The following text contains a TOEFL iBT question. It may include a passage, a conversation or lecture transcript, the question sentence, and the answer choices, all mixed together and possibly noisy.\n\n" +
          combinedContext +
          "\n\n" +
          "Your task:\n" +
          "1. Infer the most likely TOEFL-style question and answer choices from this noisy text.\n" +
          "2. Choose the single best answer (or answer set) according to the TOEFL iBT rules.\n" +
          "3. Estimate your probability that this answer is correct.\n" +
          "4. Explain in Korean why your answer is correct and why other options are wrong.\n\n" +
          "Output format (STRICT):\n" +
          "[ANSWER] <정답만 간단히 – 예: 3, 2, A, B, C and D, or a short English phrase>\n" +
          "p=<NUMBER between 0 and 1>\n" +
          "[WHY]\n" +
          "- 한국어로 정답 근거\n" +
          "- 다른 보기가 왜 오답인지 간단히\n\n" +
          "If you are less than 10% confident overall, output a single question mark '?' in [ANSWER] and use p<=0.10.\n" +
          "Do not add any extra sections or text outside this format."
      }
    ];
  }

  if (mode === "writing") {
    return [
      baseSystem,
      {
        role: "user",
        content:
          "Mode: WRITING (Integrated or Academic Discussion).\n" +
          "You will see the text captured from the screen (reading passage, question prompt, instructions, etc.) and possibly an audio transcript (lecture, conversation, or additional instructions).\n\n" +
          combinedContext +
          "\n\n" +
          "Assume this is a TOEFL iBT writing task (either Integrated or Academic Discussion).\n" +
          "Your job is to write the best possible high-scoring essay in English, using the reading and listening information appropriately.\n\n" +
          "Guidelines:\n" +
          "- Length: about 250–320 words total.\n" +
          "- Clear structure: introduction, 2–3 body paragraphs, and a brief conclusion.\n" +
          "- For integrated tasks: accurately summarize how the listening supports/opposes key points from the reading.\n" +
          "- For discussion/independent tasks: present a clear opinion, 2–3 supporting reasons, and concrete examples.\n" +
          "- Ignore noisy characters or irrelevant scraps of text; reconstruct a clean version of the task in your head.\n\n" +
          "After writing, estimate how strong this essay would score on TOEFL (0–1 probability that it would get a top band).\n\n" +
          "Output format (STRICT):\n" +
          "[ESSAY]\n" +
          "(영어 에세이 본문)\n" +
          "p=<NUMBER between 0 and 1>\n" +
          "[FEEDBACK]\n" +
          "(한국어로 에세이의 장점/단점, 개선 팁을 간단히 적어라)\n\n" +
          "Do not add any other headings or sections."
      }
    ];
  }

  if (mode === "speaking") {
    // speaking 전용: 화면 텍스트가 없고 음성 질문만 있을 수 있음.
    return [
      baseSystem,
      {
        role: "user",
        content:
          "Mode: SPEAKING.\n" +
          "You are helping a student practice TOEFL iBT speaking.\n" +
          "The text below is a noisy mixture of the task instructions, the reading passage (if any), and the listening transcript (if any). " +
          "The student is NOT providing their own answer here. Instead, you must create the best possible high-scoring model answer yourself.\n\n" +
          combinedContext +
          "\n\n" +
          "Your job:\n" +
          "1. Infer what kind of TOEFL speaking task this is (independent, campus conversation, academic integrated, etc.).\n" +
          "2. Using the reading and/or listening information, generate a model response that would score very highly.\n" +
          "3. Length: about what a human could say in 45–60 seconds: roughly 110–160 words in English.\n" +
          "4. Speak naturally, clearly, and coherently. Use simple but precise vocabulary.\n" +
          "5. Do NOT evaluate any student answer (there is none). Only create the model answer and a short evaluation as if you were the rater.\n" +
          "6. Estimate how confident you are that your response fully answers the intended task (0–1).\n\n" +
          "Output format (STRICT):\n" +
          "[EVAL]\n" +
          "(영어 한두 문장으로 이 모범 답이 어느 정도 점수일지 평가 + 아주 짧은 코멘트)\n" +
          "p=<NUMBER between 0 and 1>\n" +
          "[MODEL]\n" +
          "(영어 모범 답변 – 110~160 단어 정도)\n" +
          "[KOREAN]\n" +
          "(한국어로 이 답변의 전략/구조를 간단히 설명하고, 학생이 따라 말할 때 주의할 점을 적어라)\n\n" +
          "Do not add any other sections. If the task is unclear, still make your best guess and answer it; only use '?' if the task is almost completely unknowable."
      }
    ];
  }

  // fallback (이론상 도달 X)
  return [
    baseSystem,
    {
      role: "user",
      content:
        "Unknown mode. Just summarize the following text briefly in English and Korean.\n\n" +
        combinedContext
    }
  ];
}
