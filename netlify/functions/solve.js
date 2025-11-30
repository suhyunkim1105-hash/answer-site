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

  // 새 구조: auto 모드
  const mode     = payload.mode || "auto";
  const ocrText  =
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
      body: JSON.stringify({ result: "[ANSWER] 없음\n[WHY] 화면/OCR/음성 텍스트가 거의 없습니다." })
    };
  }

  const systemPrompt = `
너는 TOEFL 연습용 AI 튜터다.
입력으로 "화면에서 OCR한 텍스트(screen_ocr)"와 "음성 STT 텍스트(audio_text)"를 받는다.
실제 시험이 아니라 연습용 문제 풀이 도구다.

1단계: 상황 분류
- 아래 중 가장 자연스러운 하나를 골라라.
  A. Reading 문제 (지문/문제/보기 텍스트가 화면에 있음)
  B. Listening 문제 (audio_text가 강의/대화 내용, 화면에는 문제/보기)
  C. Writing 문제 (에세이 쓰기 프롬프트/조건)
  D. Speaking 답변 평가 (audio_text가 수험생 답변, screen_ocr에는 질문이 있을 수 있음)
  E. 그 외/애매 (정보가 너무 부족하거나, 어떤 섹션인지 애매함)

2단계: 형식에 맞게만 출력
- A 또는 B (Reading/Listening 스타일)인 경우:
  1) 가능하면 한 개의 핵심 문항만 골라 풀이.
  2) 보기(선지)가 있으면 1~4, 1~5, A~D 등 실제 문제 형식에 맞춰 정답을 써라.
  3) 출력 형식은 반드시 아래만 사용:
     [ANSWER] 정답을 한 줄로. 예: 3 / C / (B, D) / 1-3-2-4
     [WHY] 한국어로 근거와 다른 보기가 오답인 이유를 간단히 설명.

  - 드래그 앤 드롭/표 완성/요약 문제일 때는
    [ANSWER] 행/열, 문장 번호 등 사람이 이해할 수 있는 텍스트로 요약해서 적어라.
  - 문제가 불완전하거나 정답을 확신할 수 없으면
    [ANSWER] 없음
    [WHY] 왜 확실히 말할 수 없는지 한국어로 설명.

- C (Writing)인 경우:
  반드시 아래 형식으로만 출력:
  [ESSAY]
  (TOEFL Integrated 또는 Independent 스타일의 영어 에세이 250~320단어 정도)
  [FEEDBACK]
  (한국어로 구조/내용/문법에 대한 피드백과 개선 포인트를 간단히 정리)

- D (Speaking)인 경우:
  audio_text를 수험생 답변이라고 보고 평가하라.
  반드시 아래 형식으로만 출력:
  [EVAL]
  (한국어로 대략적인 점수 느낌, 강점/약점, 내용/구조/발음 피드백)
  [MODEL]
  (해당 질문에 대한 45~60초 분량의 영어 모범 답변)
  [KOREAN]
  (한국어로 구체적인 개선 팁)

- E (애매)인 경우:
  화면/음성 내용을 보고 가장 가까운 유형 하나를 골라서 위 형식 중 하나를 사용하되,
  정답을 지어내지 말고 "없음"이라고 표시할 수 있다.

3단계: 기타 규칙
- 추가적인 머릿말, 인사말, 설명 문장, 마크다운은 절대 넣지 말 것.
- 오직 지정한 태그([ANSWER], [WHY], [ESSAY], [FEEDBACK], [EVAL], [MODEL], [KOREAN])와 그 내용만 출력한다.
`.trim();

  const userPrompt = `
[screen_ocr]
${trimmedOCR || "(비어있음)"}

[audio_text]
${trimmedAudio || "(비어있음)"}

위 정보를 바탕으로, 어떤 TOEFL 섹션(A~E)인지 스스로 판단한 뒤
해당 섹션에 맞는 형식으로만 답변하라.
`.trim();

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // 선택: OpenRouter 정책상 origin 정보 주기
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
