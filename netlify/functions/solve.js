// netlify/functions/solve.js

exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "POST only" })
    };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model  = process.env.OPENROUTER_MODEL || "openai/gpt-4.1-mini";

  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing OPENROUTER_API_KEY" })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid JSON body" })
    };
  }

  const modeRaw = (payload.mode || "auto").toString().toLowerCase();
  const mode = ["reading", "listening", "writing", "speaking"].includes(modeRaw)
    ? modeRaw
    : "auto";

  const ocrText =
    (payload.ocrText || "") +
    (payload.passage || "") +
    (payload.question || "");
  const audioText =
    payload.audioText ||
    payload.stt ||
    "";

  const trimmedOCR   = (ocrText || "").trim();
  const trimmedAudio = (audioText || "").trim();

  if (!trimmedOCR && !trimmedAudio) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        result: "[ANSWER] 없음\n[WHY] 화면/OCR/음성 텍스트가 거의 없습니다."
      })
    };
  }

  const systemPrompt = `
너는 TOEFL 연습용 AI 튜터다.
브라우저에서 보이는 화면을 OCR한 텍스트(screen_ocr)와
수험자가 말한 음성을 STT한 텍스트(audio_text)를 기반으로 문제를 풀거나 평가한다.

입력으로 mode_hint를 추가로 받는다. (실제 값: "${mode}")

mode_hint 규칙:
- "reading"   → Reading 문제로 간주하고 Reading 형식으로만 답한다.
- "listening" → Listening 문제로 간주하고 Listening 형식으로만 답한다.
- "writing"   → Writing 에세이 문제로 간주한다.
- "speaking"  → Speaking 답변 평가 문제로 간주한다.
- "auto"      → 위 네 가지 중에서 가장 자연스러운 섹션을 스스로 판단한다.

중요: 화면 OCR과 STT 텍스트는 불완전하고 노이즈가 많을 수 있다.
그러나 수험자는 "정확도가 떨어져도 일단 정답 후보를 듣고 싶어 한다".
따라서 다음 규칙을 반드시 지켜라.

--------------------------------
[Reading / Listening 모드]

- 지문/문제/보기를 보고 한 개의 핵심 문항만 골라 풀어라.
- 항상 [ANSWER] 줄에는 정답 후보를 채워라.
  - 예: 3 / C / (B, D) / 1-3-2-4 / 첫 번째 열에 ①, ②, ⑤
  - 확신이 낮으면 "3 (추측)" 처럼 괄호 안에 추측임을 표시해도 좋다.
- 정말로 문제인지조차 구분이 안 될 정도로 텍스트가 부족할 때만
  예외적으로 [ANSWER] 없음 을 사용할 수 있다.
- 출력 형식 (정확히 지켜라):

  [ANSWER] 한 줄 정답 또는 정답 후보 (필요하면 "(추측)" 등 표시)
  [WHY] 한국어로 근거와 다른 보기들이 오답인 이유를 간단히 설명.
        확신이 낮다면 그 사실(추측임)을 여기서도 명시하라.

--------------------------------
[Writing 모드]

- screen_ocr와 audio_text를 보고, TOEFL Writing(통합형/독립형)에 어울리게 에세이를 작성한다.
- 항상 에세이와 피드백을 채워라. 정보가 부족하면 "가능한 범위에서 추측"해서 작성하되
  자료 부족 사실을 피드백에 명시해라.
- 출력 형식:

  [ESSAY]
  (TOEFL 스타일의 영어 에세이, 250~320 단어 정도. 단락을 나누어 작성.)
  [FEEDBACK]
  (한국어로 구조/내용/문법에 대한 피드백과 개선 포인트를 간단히 정리.
   정보 부족/추측 여부도 여기서 밝혀라.)

--------------------------------
[Speaking 모드]

- audio_text를 수험자의 Speaking 답변이라고 보고 평가한다.
- 출력 형식:

  [EVAL]
  (한국어로 대략적인 점수 느낌, 강점/약점, 내용/구조/발음에 대한 피드백.
   STT가 부정확하면 그 점도 언급.)
  [MODEL]
  (해당 질문에 대한 45~60초 분량의 영어 모범 답변)
  [KOREAN]
  (한국어로 구체적인 개선 팁, 어떤 식으로 말하면 더 좋은지)

--------------------------------
[Auto 모드]

- mode_hint = auto 일 때만 사용한다.
- 입력을 보고 Reading/Listening/Writing/Speaking 중 하나를 선택하고,
  선택한 섹션의 형식으로만 출력한다.

--------------------------------
공통 규칙:
- 절대로 인사말, 마크다운, 불필요한 텍스트를 추가하지 말고,
  아래 태그만 사용하라: [ANSWER], [WHY], [ESSAY], [FEEDBACK], [EVAL], [MODEL], [KOREAN]
- Reading/Listening에서는 웬만하면 항상 [ANSWER]에 뭔가를 채워라.
- 불확실하면 [ANSWER]에서 "3 (추측)"처럼 표시하고,
  [WHY]에서 왜 확신이 낮은지 설명하라.
`.trim();

  const userPrompt = `
[mode_hint]
${mode}

[screen_ocr]
${trimmedOCR || "(비어있음)"}

[audio_text]
${trimmedAudio || "(비어있음)"}

위 정보를 바탕으로, mode_hint 규칙에 따라 해당 섹션 형식으로만 답변하라.
`.trim();

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app/",
        "X-Title": "answer-site"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("OpenRouter error:", resp.status, text);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "OpenRouter request failed", detail: text })
      };
    }

    const data = await resp.json();
    const resultText =
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content
        ? data.choices[0].message.content
        : "";

    return {
      statusCode: 200,
      body: JSON.stringify({ result: resultText })
    };
  } catch (e) {
    console.error(e);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Exception calling OpenRouter", detail: e.toString() })
    };
  }
};
