// netlify/functions/solve.js
// -------------------------
// 역할: 편입 영어 객관식 기출 "정답만" 생성하는 함수 (전체 기출 공용)
// 입력: { ocrText: string, page?: number }
// 출력: { ok: true, text: "1: 4\n2: 3\n...", debug: {...} } 또는 { ok: false, error: "..." }
//
// 필요한 환경변수 (Netlify 에서 설정):
// - OPENROUTER_API_KEY  (필수, OpenRouter 키)
// - MODEL_NAME          (선택, 기본값: "openai/gpt-4.1")
// - TEMPERATURE         (선택, 기본값: 0.1)
// - STOP_TOKEN          (선택, 기본값: "XURTH")

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

// OpenRouter 호출용 헬퍼 (Node 18+ 전역 fetch 사용, node-fetch 필요 없음)
async function callOpenRouter({ apiKey, model, temperature, stopToken, page, ocrText }) {
  const systemPrompt = `
너는 "편입영어 객관식 기출 채점/정답키 생성" 전용 AI다.
입력은 한국 대학교 편입 영어시험지의 OCR 텍스트이며, 한국어 안내문・페이지 번호・잡음이 섞여 있을 수 있다.

[최우선 목표]
1) 오답 최소화
2) 문항 누락 0개: OCR 텍스트에 '보이는 모든 문항번호'에 대해 반드시 답을 출력한다.
3) 최종 출력은 "정답만"이다. (설명·해설·요약·머리말 금지)

[문항/선지 형태]
- 문항번호: 보통 아라비아 숫자 (1, 2, 3, ..., 40 등).
- 선지: 
  - A, B, C, D, E처럼 알파벳으로 주어질 수도 있고,
  - ① ② ③ ④ ⑤처럼 숫자형 선지일 수도 있다.
- OCR 과정에서 약간의 오타, 줄넘김, 공백 문제가 있을 수 있다.

[출력 형식(필수 규칙)]
1) 한 줄에 하나씩만, 아래 둘 중 하나 형식으로 출력한다.
   - "문항번호: A" (선지가 A~E, 혹은 a~e인 경우)
   - "문항번호: 1" (선지가 ①~⑤, 혹은 1~5인 경우)
2) 반드시 콜론(":") 뒤에 한 칸 공백을 넣는다. 예) "13: 2"
3) 선택지는 A~E 또는 1~5 중 하나만 사용한다.
4) 불확실한 문항은 그래도 최선의 답을 하나 고른 뒤,
   - 해당 줄 끝에 "?"를 붙인다. 예) "13: 2?"
5) 마지막 줄에만 아래 형식으로 불확실한 번호를 정리한다.
   - "UNSURE: 13 24 28"
   - 불확실한 번호가 하나도 없으면 "UNSURE:"만 출력한다.
6) 이 형식 외의 어떤 텍스트(머리말, 설명, 해설, 말줄임표, 장식, 공백줄)도 출력하지 않는다.

[내부 절차(생각만 하고, 출력하지 마라)]
0) 전체 OCR 텍스트에서 문항번호 패턴(1., 2), 3] 등)을 스캔하여,
   - 실제 문제로 보이는 번호들만 정리한다.
1) 각 문항에 대해:
   - 문항의 지문/질문과 선지(A~E 또는 1~5)를 최대한 복원해 이해한다.
   - 선지가 다음 페이지에 있을 수 있다는 점을 감안해,
     같은 번호 범위 안의 이어지는 문장을 한 세트로 본다.
2) 어휘/빈칸/독해 유형에 맞춰 가장 타당한 정답을 고른다.
3) OCR이 일부 잘려 있거나 문장이 끊겨 있더라도,
   - 추론 가능한 한 최선을 다해 정답을 하나 고른다.
   - 이때 확신도가 낮다고 판단되면 해당 번호를 "불확실"로 표시한다.
4) 모든 문항번호를 빠짐없이 다뤘는지 다시 한번 체크한 뒤,
   - 누락 없이 "문항번호: 정답" 형식으로만 나열한다.
   - 마지막 줄에 UNSURE 줄을 추가한다.

[주의]
- 한국어 부분(지시문, 보기 설명 등)은 참고만 하고,
  영어 지문/질문/선지를 중심으로 풀어라.
- 출력은 반드시 위에서 지정한 포맷만 사용하라.
  (예: "2: D", "15: 3?", "UNSURE: 15 18")
  다른 문장은 절대 출력하지 말 것.
`.trim();

  const userPrompt = `
다음은 한국 대학교 편입 영어 객관식 시험지의 OCR 텍스트다.
- 시험 종류: 편입 영어 객관식
- 페이지 번호(참고용): ${page}

[OCR 텍스트 시작]
${ocrText}
[OCR 텍스트 끝]

위 텍스트에 실제로 보이는 문항번호들에 대해,
반드시 "문항번호: 정답" 형식으로만 답하고,
마지막 줄에 "UNSURE: ..." 줄을 추가하라.
`.trim();

  const body = {
    model,
    temperature,
    stop: [stopToken],
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://answer-site.netlify.app",
      "X-Title": "answer-site-central"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter HTTP ${res.status} ${res.statusText} - ${text}`);
  }

  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content
    ? String(choice.message.content).trim()
    : "";

  return {
    raw: data,
    content,
    finishReason: choice && choice.finish_reason ? choice.finish_reason : null
  };
}

// "문항번호: 답" / "UNSURE: ..." 파싱해서 디버그용 객체 생성
function parseAnswerLines(text) {
  const lines = String(text || "").split(/\r?\n/);
  const answers = {};
  const questionNumbers = [];
  let unsure = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // UNSURE 줄
    const mUnsure = line.match(/^UNSURE\s*:\s*(.*)$/i);
    if (mUnsure) {
      const tail = mUnsure[1].trim();
      if (!tail) {
        unsure = [];
      } else {
        unsure = tail
          .split(/[,\s]+/)
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => Number(x))
          .filter((n) => !Number.isNaN(n));
      }
      continue;
    }

    // "번호: 정답" 또는 "번호-정답" 허용 (콜론 우선)
    const m = line.match(/^(\d{1,3})\s*[:\-]\s*([A-Ea-e1-5])\s*\??$/);
    if (m) {
      const q = Number(m[1]);
      let a = String(m[2]).toUpperCase();
      answers[q] = a;
      if (!questionNumbers.includes(q)) questionNumbers.push(q);
    }
  }

  questionNumbers.sort((a, b) => a - b);
  return { answers, questionNumbers, unsure };
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
    const ocrText = String(body.ocrText || body.text || "");

    if (!ocrText.trim()) {
      return json(400, { ok: false, error: "ocrText is empty" });
    }

    let or;
    try {
      or = await callOpenRouter({
        apiKey,
        model,
        temperature,
        stopToken,
        page,
        ocrText
      });
    } catch (e) {
      return json(500, {
        ok: false,
        error: "OpenRouter request failed",
        detail: e && e.message ? e.message : String(e || "")
      });
    }

    const content = or.content || "";
    const parsed = parseAnswerLines(content);

    return json(200, {
      ok: true,
      text: content,
      debug: {
        page,
        model,
        finishReason: or.finishReason,
        questionNumbers: parsed.questionNumbers,
        answers: parsed.answers,
        unsure: parsed.unsure
      }
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "Unhandled error in solve function",
      detail: e && e.message ? e.message : String(e || "")
    });
  }
};
