// netlify/functions/solve.js
// --------------------------------------
// 중앙대학교 편입 영어 객관식 기출 "정답만" 생성 전용 함수
// 입력: { ocrText: string, page?: number }
// 출력: { ok: true, text: "1: 3\n2: 4\n..." , debug: {...} }
//
// 환경변수 (Netlify):
// - OPENROUTER_API_KEY  (필수)
// - MODEL_NAME          (선택, 기본 "openai/gpt-4.1")
// - TEMPERATURE         (선택, 기본 0.1)
// - STOP_TOKEN          (선택, 기본 "XURTH")

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

// OCR 텍스트에서 문항번호 후보 뽑기 (예: "12.", "12)" 이런 패턴)
function extractQuestionNumbers(ocrText) {
  if (!ocrText) return [];
  const found = new Set();
  const regex = /(?:^|\n)\s*(\d{1,3})\s*[.)]/g;
  let m;
  while ((m = regex.exec(ocrText)) !== null) {
    const n = Number(m[1]);
    if (!Number.isNaN(n) && n > 0 && n <= 100) {
      found.add(n);
    }
  }
  return Array.from(found).sort((a, b) => a - b);
}

// 모델 출력에서 "번호: 정답" 구조 파싱 (디버그용)
function parseAnswersFromText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const answers = {};
  const regex = /^(\d{1,3})\s*[:\-]\s*([A-E1-5])\??\b/i;

  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln) continue;
    const m = ln.match(regex);
    if (!m) continue;
    const qNum = Number(m[1]);
    let ans = m[2].toUpperCase();
    answers[qNum] = ans;
  }
  return answers;
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

    const questionNumbers = extractQuestionNumbers(ocrText);
    const qNumHint =
      questionNumbers.length > 0
        ? `이 페이지 OCR에서 탐지된 문항번호 후보: ${questionNumbers.join(
            ", "
          )}.`
        : "이 페이지의 OCR에서 문항번호를 직접 찾아야 한다.";

    // ---- OpenRouter 요청 ----
    const promptUser = `
너는 "중앙대학교 편입 영어 객관식 기출 채점 AI"이다.

[시험 유형]
- 대상: 중앙대학교 인문/사회계열 편입 영어 기출 (여러 연도, 여러 유형 혼합).
- 한 페이지에 여러 유형이 섞여 있을 수 있다:
  - 어휘: 밑줄 친 단어와 가장 가까운 의미, 반의어, 문맥상 적절한 단어 등.
  - 문장삽입/순서: (A)(B)(C)(D) 문단, 문장 배치.
  - 제목/요지/주장/함의.
  - 내용일치/불일치.
- 선택지는 보통 ①~④ 또는 ①~⑤ 형태이고, OCR 과정에서 "1,2,3,4,5"나 "A,B,C,D,E" 등으로 깨질 수 있다.

[입력]
- 아래에 중앙대 편입 영어 시험지의 한 페이지 전체가 OCR 텍스트로 주어진다.
- OCR 특성상 줄바꿈/띄어쓰기/철자/번호/동그라미 숫자(①②③④⑤)가 다소 깨져 있을 수 있다.
- ${qNumHint}

[최우선 목표]
1) 오답 최소화 (가능한 한 정확한 정답 선택)
2) 문항 누락 0: OCR에 '보이는 모든 문항번호'는 전부 답을 출력한다.
3) 형식 준수:
   - 각 줄은 반드시 "문항번호: 정답번호" 형식으로만 출력.
   - 정답번호는 **숫자 1~5** 또는 알파벳 A~E 둘 중 하나로만 사용.
     (예: "3: 2" 또는 "3: B")
   - 한 줄에 하나의 문항만.
   - 그 외 아무 텍스트(해설, 이유, 설명, 머리말, 마크다운, 공백 줄 등)도 출력하지 말 것.
4) 불확실한 경우:
   - 그래도 가장 가능성 높은 선택지를 하나 고른다.
   - 그 줄 끝에 "?"를 붙여라. (예: "12: 3?")
   - 그리고 마지막 줄에 "UNSURE: 12, 17" 처럼 불확실한 문항번호를 콤마로 나열한다.
   - 확실한 문항이 없으면 UNSURE 줄 생략 가능.

[해석/추론 규칙]
- 지문과 선택지를 최대한 정상적인 시험지 형식으로 복원해서 읽는다.
- 번호/선지 사이의 줄바꿈·공백·특수문자는 전부 무시하고 의미 단위로 다시 묶어서 이해하라.
- ①②③④ 같은 기호가 깨져 있어도, 순서를 보고 1~4번 선택지로 매핑해서 판단할 것.
- "다음 글을 읽고 물음에 답하시오" 같은 안내 문구, 연도, A형/B형, 페이지 번호([6-1] 등)는 전부 무시한다.
- 지문과 보기가 앞뒤 페이지로 나뉘어 있을 수 있으므로, **주어진 전체 텍스트를 한 덩어리의 시험지**처럼 보고,
  그 안에서 보이는 모든 문항번호에 대해 정답을 결정하라.

[출력 형식 요약]
- 예시 1 (확실한 경우):
  1: 3
  2: 4
  3: 1

- 예시 2 (일부 불확실한 경우):
  1: 3
  2: 4?
  3: 1
  UNSURE: 2

지금부터 아래 OCR 텍스트를 보고,
보이는 **모든 객관식 문항**에 대해 위의 형식으로만 정답을 출력하라.

----- OCR TEXT START -----
${ocrText}
----- OCR TEXT END -----
`.trim();

    const payload = {
      model,
      temperature,
      top_p: 0.95,
      presence_penalty: 0,
      frequency_penalty: 0,
      stop: [stopToken],
      messages: [
        {
          role: "system",
          content:
            "너는 중앙대학교 편입 영어 객관식 시험의 정답만 출력하는 채점 AI이다. 항상 형식을 엄격히 지키고, 다른 설명 문장은 절대 출력하지 마라.",
        },
        {
          role: "user",
          content: promptUser,
        },
      ],
    };

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://answer-site.netlify.app/",
        "X-Title": "CAU Transfer English Auto Solver",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return json(resp.status, {
        ok: false,
        error: `OpenRouter request failed: ${resp.status}`,
        detail: errText.slice(0, 500),
      });
    }

    const data = await resp.json().catch(() => null);
    if (!data) {
      return json(500, { ok: false, error: "Failed to parse OpenRouter response" });
    }

    const choice = data.choices && data.choices[0];
    const content = choice?.message?.content || "";
    const finishReason = choice?.finish_reason || "unknown";

    const answers = parseAnswersFromText(content);

    return json(200, {
      ok: true,
      text: content.trim(),
      debug: {
        page,
        model,
        questionNumbers,
        answers,
        finishReason,
      },
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "Unhandled error in solve function",
      detail: e?.message || String(e),
    });
  }
};
