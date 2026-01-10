// netlify/functions/solve.js
// --------------------------------------------------
// 한국 편입 영어 객관식 기출 자동 정답 생성기
// (중앙대/서강대/한양대 등 전체 공용)
//
// 입력:  { ocrText: string, page?: number }
// 출력:  { ok: true, text: "1: 4\n2: 3\n...", debug: {...} }
//
// 환경변수 (Netlify):
// - OPENROUTER_API_KEY  (필수)
// - MODEL_NAME          (선택, 기본 "openai/gpt-4.1")
// - TEMPERATURE         (선택, 기본 0.1)
// - STOP_TOKEN          (선택, 기본 "XURTH")

// Node 18 이상이면 fetch 내장이라도, 호환성을 위해 polyfill 한 번 더 정의
const fetchFn = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

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

// OCR 텍스트에서 문항번호 후보 추출 (줄 시작의 "12.", "12)" 등)
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

// 모델 응답에서 "번호: 정답" 페어만 추출
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
        ? `이 OCR 텍스트에서 자동으로 검출된 문항번호 후보: ${questionNumbers.join(
            ", "
          )}. 이 번호들은 반드시 모두 포함해서 답을 출력해야 한다.`
        : "이 OCR 텍스트 안에서 문항번호를 직접 찾아야 한다. 눈에 보이는 모든 객관식 문항번호에 대해 답을 출력하라.";

    // --------------- OpenRouter 프롬프트 ----------------
    const userPrompt = `
너는 "한국 대학 편입 영어 객관식 기출 채점 AI"이다.

[시험 범위]
- 중앙대학교 인문/사회계열 편입 영어 기출을 포함해서,
  한국 대학 편입 영어 객관식 시험지 전체(서강대, 한양대 등)에 공통으로 적용된다.
- 한 OCR 텍스트에는 다음이 섞여 있을 수 있다:
  - 어휘, 회화, 문법, 문장 삽입/순서, 제목/요지/주장, 내용 일치·불일치, 함의 문제 등
  - 한 지문에 대해 2~3개 문항(예: 37, 38)이 붙어 있는 세트
  - 지문 앞부분과 뒷부분이 서로 다른 물리 페이지에서 온 텍스트가 합쳐진 경우
- 선지는 ①~④/①~⑤지만, OCR 과정에서 "1 2 3 4 5"나 "A B C D E" 등으로 깨질 수 있다.

[입력]
- 아래에 편입 영어 시험지의 OCR 텍스트 한 덩어리가 주어진다.
- 줄바꿈/띄어쓰기/특수문자/번호 표시는 일부 깨져 있을 수 있다.
- ${qNumHint}

[최우선 목표]
1) 오답 최소화:
   - 지문이 여러 페이지에 걸쳐 있거나, 한 지문에 2개 이상 문항이 붙은 경우라도
     OCR 텍스트 전체를 하나의 덩어리로 보고, 시험 출제 의도에 맞게 가장 타당한 선택지를 고른다.
2) 문항 누락 0:
   - OCR 텍스트 안에서 "8.", "8)", "⑧"처럼 보이는
     모든 객관식 문항번호마다 반드시 하나씩 답을 출력한다.
   - 지문/선지가 일부 부족해도, 가장 가능성 높은 선택지를 하나 골라서 찍되, 불확실하면 "?"를 붙인다.
3) 출력 형식:
   - 각 줄은 반드시 "문항번호: 정답" 또는 "문항번호: 정답?" 형식이어야 한다.
     예) 9: 3
         12: B?
   - 정답은 숫자 1~5 또는 알파벳 A~E 중 하나로만 쓴다.
   - 한 줄에 하나의 문항만.
   - 마지막 줄에 선택적으로 "UNSURE: 9, 12, 25" 처럼 불확실한 번호를 콤마로 나열할 수 있다.
   - 그 외의 어떤 텍스트(해설, 이유, 설명, 머리말, 마크다운, 공백 줄 등)도 절대 출력하지 않는다.

[내부 사고 절차]  (생각만 하고 출력하지 말 것)
0단계) 문항 수집
  - OCR 텍스트 전체를 훑으면서 "1.", "1)", "① 1." 등 객관식 문항번호를 모두 찾는다.
  - ${qNumHint}

1단계) 각 문항별 초안 정답 선택
  - 지문과 선택지를 가능한 한 원래 시험지 형식으로 복원해서 읽는다.
  - 각 문항 유형(어휘/빈칸/내용일치/제목/순서 등)을 먼저 파악한다.
  - 한 지문에 2~3개 문항이 붙어 있을 경우, 지문 전체를 공통 정보로 사용해 각 문항의 정답 후보를 선택한다.
  - 지문/선지가 일부만 보이는 문항은, 보이는 정보만으로 최선의 추론을 하고 자신이 낮다면 "불확실"로 표시한다.

2단계) 검산 및 누락 확인
  - 수집한 문항번호 목록과 방금 답을 만든 문항번호 목록을 비교한다.
  - 빠진 번호가 있으면 반드시 채워 넣는다.
  - 각 문항의 정답이 1~5 또는 A~E 형식을 지키는지 확인한다.
  - 불확실한 문항들을 모아 최종적으로 "UNSURE: ..." 한 줄로 정리한다.

3단계) 최종 출력
  - 각 문항에 대해 "번호: 정답" 또는 "번호: 정답?"만 한 줄씩 출력한다.
  - 마지막 줄에 "UNSURE: ..." 한 줄을 추가할 수 있다.
  - 이 형식 외에 그 어떤 설명도 쓰지 않는다.

[출력 예시]

(예시 1: 모두 확실할 때)
1: 4
2: 3
3: 1

(예시 2: 일부 불확실할 때)
1: 4
2: 3?
3: 1
UNSURE: 2

이제 아래 OCR 텍스트를 보고,
그 안에서 눈에 보이는 **모든 객관식 문항번호**에 대해 위 형식대로만 정답을 출력하라.

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
            "너는 한국 대학 편입 영어 객관식 시험(중앙대, 서강대, 한양대 등)의 정답만 출력하는 채점 AI이다. 출력 형식을 절대 어기지 말고, 해설/머리말/불필요한 텍스트는 절대 쓰지 마라.",
        },
        { role: "user", content: userPrompt },
      ],
    };

    const resp = await fetchFn("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://answer-site.netlify.app/",
        "X-Title": "KR Transfer English Auto Solver",
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
