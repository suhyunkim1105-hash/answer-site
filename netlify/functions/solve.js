// netlify/functions/solve.js
// 편입영어 객관식 기출 자동 채점용 solve 함수
// - 입력: { page, ocrText } (또는 { text })
// - 출력: { ok, text: "1: A\n2: D...", debug: { ... } }

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(obj),
  };
}

// 모델 출력에서 "번호: 선택지"만 뽑아서 정리
function parseAnswers(raw) {
  if (!raw) return { questionNumbers: [], answers: {} };

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const answers = {};
  const questionNumbers = [];

  const choiceMapDigitToLetter = {
    "1": "A",
    "2": "B",
    "3": "C",
    "4": "D",
    "5": "E",
  };

  for (const line of lines) {
    // 기대 포맷: "12: A" 또는 "12:A" 또는 "12 - A"
    const m = line.match(/^(\d+)\s*[:\-]\s*([A-E1-5])/i);
    if (!m) continue;

    const qNum = parseInt(m[1], 10);
    let choice = m[2].toUpperCase();

    if (choiceMapDigitToLetter[choice]) {
      choice = choiceMapDigitToLetter[choice];
    }

    if (!["A", "B", "C", "D", "E"].includes(choice)) continue;

    answers[String(qNum)] = choice;
    questionNumbers.push(qNum);
  }

  // 중복 제거 + 정렬
  const uniqNums = Array.from(new Set(questionNumbers)).sort((a, b) => a - b);
  return { questionNumbers: uniqNums, answers };
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
    const temperature = Number(process.env.TEMPERATURE ?? 0.0);
    const maxTokens = Number(process.env.MAX_TOKENS ?? 512);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const ocrText = String(body.ocrText || body.text || "").trim();

    if (!ocrText) {
      return json(400, { ok: false, error: "Missing ocrText/text" });
    }

    // ----------------- 프롬프트 (강화 버전) -----------------
    const systemPrompt = `
You are an answer-key generator for Korean university transfer English multiple-choice exams
(문항 수는 대략 1–40, 5지선다 A–E).

You receive raw OCR text of ONE test page, including:
- Question numbers (e.g., 1., 2., 10., 14., 24., 28., 29., 33., 40.)
- Question stems and options (A–E or ①–⑤)
- Section headings like [QUESTIONS 1-4], instructions, etc.

Your ONLY job:
- For EVERY visible question number in the OCR text,
  output EXACTLY one final answer choice.

==================================================
A. 출력 형식 (가장 중요)
==================================================
1) 최종 출력은 오직 아래 형식의 줄들만:
   "<번호>: <선택지>"
   예:
   1: A
   2: D
   3: C

2) <번호>는 정수 (1, 2, ..., 40 등).
3) <선택지>는 반드시 대문자 A, B, C, D, E 중 하나.
4) 그 외:
   - 해설, 이유, 설명, 메모, 영어/한국어 문장, 표 등은 절대 출력하지 않는다.
   - "UNSURE", "UNKNOWN", "ANSWER:" 같은 단어도 절대 쓰지 않는다.
   - 생각 과정은 내부에서만 하고, 최종 출력은 정답 맵만 남긴다.

5) 번호는 오름차순으로 정렬해서 출력한다.

==================================================
B. 커버리지: 문항 누락 금지
==================================================
1) OCR 텍스트 전체를 스캔해서, 이 페이지에 실제로 포함된
   "문항 번호"를 모두 찾는다.
   - 예: 1–15 페이지면 1~15,
         16–23 페이지면 16~23,
         24–32 페이지면 24~32,
         33–40 페이지면 33~40
   - 단, OCR 노이즈(93-35 같은 깨진 숫자)는 문맥을 보고
     실제 의도된 범위(예: 33–35)로 판단한다.

2) 번호가 보이고, 그 번호 주변에 문항의 지문/보기(A–E)가 보이면
   무조건 그 번호에 대해 정답 하나를 출력해야 한다.
   - 보기 일부가 잘렸거나 약간 흐려져도, 문맥상 가장 가능성이 높은
     하나를 골라서 답을 출력한다.
   - 어떤 번호도 "건너뛰기" 금지.

==================================================
C. 문항 유형별 규칙
==================================================

1) 어휘/동의어 문제 (예: 1–4번 유형)
   - 밑줄 친 단어의 의미를 해당 문맥에서 정확히 파악한다.
   - 보기 A–E 중에서, 의미·뉘앙스가 가장 잘 겹치는 단어를 고른다.
   - 사전적 정의뿐 아니라, 문장 전체의 톤과 쓰임을 고려한다.

2) 문장 완성 / 어휘 선택 (예: 5–6번, 24–32 일부)
   - 문장의 논리, 관용 표현, 전치사/동사 패턴까지 고려한다.
   - "그럴듯하지만 미세하게 어색한" 선택지를 경계하고
     실제 자연스러운 원어민 문장을 우선한다.
   - 지문과의 논리적 연결도 반드시 확인한다.

3) 문법/오류 찾기 문제 (예: 7–10번 같은 “수정해야 할 밑줄 부분”)
   - 문항에 A, B, C, D 밑줄이 있고
     "which underlined part must be corrected"류의 지시가 있으면:
     1) 각 밑줄 구간을 독립적으로 문장 속에서 확인한다.
     2) 문법(시제, 수일치, 준동사, 관계사, 전치사, 대명사, 어순),
        관용 표현, 논리 연결 모두 확인한다.
     3) 의미가 이상하지만 문법적으로는 허용되는 부분과,
        문법적으로 틀린 부분을 구분한다.
     4) 실제로 “문법·표현상 틀린 부분” 하나를 골라 답으로 출력한다.
   - 전체 문장은 여러 번 다시 읽어 보고 결정한다.
   - 이 유형에서는 “가장 덜 자연스러운 부분”이 아니라
     “실제로 잘못된 문법/표현”을 찾는 것이 목표다.

4) 문장 재배열/순서 맞추기 (예: 17–20번 유형)
   - 시간 흐름(연대기), 인과관계, 대명사/지시어 참조 대상이
     자연스럽게 이어지는 순서를 찾는다.
   - A–D 네 문장을 머릿속에서 여러 번 재배열해서
     논리적으로 가장 매끄러운 순서를 선택한다.
   - "By mid-December…" 같은 시간 표지, "this/that"가 가리키는 대상,
     “however, therefore” 같은 접속어에 특히 주의한다.

5) 지문 독해/추론/태도/용도 문제 (예: 24–32, 33–40)
   - 먼저 지문 전체를 최소 2번 이상 읽는다고 가정하고,
     핵심 주장, 톤(비판/옹호/설명), 구조(문제 제기→예시→결론)를 잡는다.
   - "NOT / EXCEPT / LEAST / FALSE / INCORRECT"가 있는지
     항상 먼저 확인한다:
     * NOT/EXCEPT/LEAST/FALSE/INCORRECT:
       - 지문이 분명히 말하는 내용과 반대이거나,
         지문에서 전혀 근거가 없는 선택지를 정답으로 고른다.
       - "가장 덜 지지되는 선택지"를 찾는 문제이다.
     * 일반 참/거짓/추론 문제:
       - 지문에서 직접 말하거나 강하게 암시하는 내용만 "참"으로 본다.
       - 과도한 일반화(항상/절대)나 지문에 없는 정보는 “틀린” 쪽일 가능성이 높다.

   - "글의 성격/화자의 정체/글의 형식"을 묻는 문제(예: 33번 유형):
     * "editorial" (신문 사설):
       - 시사 이슈에 대한 강한 의견/비판/제안 중심.
     * "term paper from a graduate student" (대학원생 리포트):
       - 비교적 건조하고 분석적, 개념 정의→분류→예시→정리 구조,
         여러 나라/시대의 예를 들며 체계적으로 논의.
         (특히 문학사/이론을 정리하면서 canonical works를 예로 들면
          term paper일 가능성이 높다.)
     * "statement from an avant-garde artist":
       - 매우 주관적/실험적, 파편적 이미지, 기존 규범 깨기 강조.
     * "cultural theory from an ethnologist":
       - 문화/관습/집단 행위(의례, 민속, 일상 습관)를
         현장조사 + 비교문화 관점에서 분석하는 톤.
       - 문학 텍스트 자체보다 "문화적 실천"에 더 초점.

     이때, 문학의 발달 단계(젊은 사회/늙은 사회), national literature,
     canonical 작품들의 예시를 차분히 나열하며 분석하는 글은
     "대학원생의 term paper" 유형에 더 가깝다.

   - 마지막 문항(예: 40번)은 지문 전체의 요지/함의/결론을
     반영하는 선택지를 고른다. 부분적인 디테일에 집착하지 말고,
     전체 구조를 대표하는 답을 선택한다.

==================================================
D. 모호한 OCR / 깨진 텍스트 처리
==================================================
1) 철자가 조금 깨져 있어도, 문맥을 보고 원래 단어를 최대한 추론한다.
2) 문항 번호가 "93-35" 같이 깨져 있어도,
   지문 구조와 다른 문항들을 보고 실제 범위(예: 33–35)로 복구한다.
3) 그래도 완벽하지 않아도, 가장 가능성이 높은 답을 하나 선택해 출력한다.

==================================================
E. 최종 정리 절차 (내부 사고용)
==================================================
1) OCR 텍스트 전체를 읽고, 이 페이지의 문항 번호 범위를 파악한다.
2) 각 문항에 대해:
   - 문항 유형(어휘/문법/순서/독해 등)을 파악한다.
   - 보기 A–E를 하나씩 비교하고 탈락시킨다.
   - 특히 NOT/EXCEPT/LEAST/ FALSE 유형은 반대로 사고한다.
3) 모든 문항에 대해 A–E 중 하나를 확실히 고른다.
4) 마지막에 번호를 오름차순으로 정리하여
   "<번호>: <선택지>" 형식만 남긴다.
5) 다른 내용(해설, 이유, 설명)은 절대 출력하지 않는다.
    `;

    const userPrompt = `
Here is the raw OCR text of ONE exam page.

OCR TEXT (page ${page}):
--------------------------------------------------
${ocrText}
--------------------------------------------------

Now do the following:

1) Detect every question number that truly belongs to this page.
2) For EACH such question number, choose exactly ONE best answer (A–E).
3) Output ONLY lines in the format "<number>: <choice>" (e.g., "16: B").
4) Sort the lines by question number in ascending order.
`;

    // ----------------- OpenRouter 호출 -----------------
    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer":
          process.env.OPENROUTER_REFERRER ||
          "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site-solve",
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt.trim() },
          { role: "user", content: userPrompt.trim() },
        ],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return json(502, {
        ok: false,
        error: `OpenRouter request failed: ${resp.status}`,
        detail: text.slice(0, 500),
      });
    }

    const data = await resp.json().catch(() => null);
    const choice = data && data.choices && data.choices[0];
    const content =
      choice && choice.message && typeof choice.message.content === "string"
        ? choice.message.content.trim()
        : "";

    if (!content) {
      return json(500, {
        ok: false,
        error: "Empty answer from model",
        dataPreview: JSON.stringify(data || {}, null, 2).slice(0, 500),
      });
    }

    const { questionNumbers, answers } = parseAnswers(content);

    const finalText = questionNumbers
      .map((n) => `${n}: ${answers[String(n)]}`)
      .join("\n");

    return json(200, {
      ok: true,
      text: finalText,
      debug: {
        page,
        model,
        questionNumbers,
        answers,
        finishReason:
          (choice && (choice.finish_reason || choice.native_finish_reason)) ||
          "",
        ocrTextPreview: ocrText.slice(0, 500),
      },
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "solve internal error",
      detail: String(err && err.message ? err.message : err),
    });
  }
};

