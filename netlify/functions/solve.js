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

섹션별 출력 형식은 아래 규칙을 반드시 지켜라.
어떤 경우에도 추가적인 마크다운, 인사말, 머릿말은 넣지 말고,
오직 지정된 태그와 내용만 출력할 것.

--------------------------------
[Reading / Listening 모드]  (mode_hint = reading 또는 listening, 혹은 auto로 그렇게 판단했을 때)

- 화면에 지문/문제/보기가 있을 때, 한 개의 핵심 문항만 골라 풀어라.
- 4지선다, 복수정답, 요약/표 완성 등 문제 형식에 맞게 답을 적되
  정답을 지어내지 말고, 자료가 너무 부족하면 "없음"이라고 명시할 수 있다.
- 출력 형식 (반드시 그대로):
  [ANSWER] 정답을 한 줄로. 예: 3 / C / (B, D) / 1-3-2-4 / 첫 번째 열에 ①, ②, ⑤
  [WHY] 한국어로 근거와 다른 보기들이 오답인 이유를 간단히 설명.

- 보기(선지)가 text로 명확하지 않으면, 정답을 대충 추측하지 말고
  [ANSWER] 없음
  [WHY] 왜 확실하게 답을 고를 수 없는지 한국어로 설명.

--------------------------------
[Writing 모드]  (mode_hint = writing, 혹은 auto로 그렇게 판단했을 때)

- screen_ocr와 audio_text를 보고, TOEFL Writing(통합형/독립형)에 어울리게 에세이를 작성한다.
- 반드시 아래 형식으로만 출력:

  [ESSAY]
  (TOEFL 스타일의 영어 에세이, 250~320 단어 정도. 단락을 나누어 작성.)
  [FEEDBACK]
  (한국어로 구조/내용/문법에 대한 피드백과 개선 포인트를 간단히 정리)

--------------------------------
[Speaking 모드]  (mode_hint = speaking, 혹은 auto로 그렇게 판단했을 때)

- audio_text를 수험자의 Speaking 답변이라고 보고 평가한다.
- 화면 텍스트(screen_ocr)는 질문/지문일 수 있다.
- 반드시 아래 형식으로만 출력:

  [EVAL]
  (한국어로 대략적인 점수 느낌, 강점/약점, 내용/구조/발음에 대한 피드백)
  [MODEL]
  (해당 질문에 대한 45~60초 분량의 영어 모범 답변)
  [KOREAN]
  (한국어로 구체적인 개선 팁, 어떤 식으로 말하면 더 좋은지)

--------------------------------
[Auto 모드]  (mode_hint = auto 일 때만)

- 위 정보를 종합하여 가장 자연스러운 섹션을 고른 뒤,
  그 섹션에 해당하는 형식을 그대로 사용한다.

--------------------------------
공통 규칙:
- 정답이나 점수를 억지로 지어내지 말 것.
- 자료가 너무 부족해서 확신할 수 없으면, Reading/Listening에서는 [ANSWER] 없음, Writing/Speaking에서는 해당 태그 안에서 "정보 부족"임을 명시하라.
- 출력은 오직 [ANSWER]/[WHY]/[ESSAY]/[FEEDBACK]/[EVAL]/[MODEL]/[KOREAN] 태그와 그 내용만 포함해야 한다.
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
