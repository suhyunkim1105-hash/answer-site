// netlify/functions/solve.js
// -------------------------
// 역할: 편입 영어 객관식 기출 "정답만" 생성하는 함수
// 입력: { ocrText: string, page?: number }
// 출력: { ok: true, text: "1: 4\n2: 3\n...", debug: {...} } 또는 { ok: false, error: "..." }
//
// 필요한 환경변수 (Netlify 에서 설정):
// - OPENROUTER_API_KEY  (필수)
// - MODEL_NAME          (선택, 예: "openai/gpt-4.1", 기본값: "openai/gpt-4.1")
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

// ---- 유틸: 문자열 트리밍 ----
function safeString(x) {
  if (x === undefined || x === null) return "";
  return String(x);
}

// ---- OCR에서 문항 번호 추출 (1~80 사이) ----
function extractQuestionNumbers(ocrText) {
  const text = safeString(ocrText);
  const nums = new Set();
  const re = /\b(\d{1,3})\s*[.)]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 80) {
      nums.add(n);
    }
  }
  const arr = Array.from(nums);
  arr.sort((a, b) => a - b);
  return arr;
}

// ---- OpenRouter 호출 ----
async function callOpenRouter({ apiKey, model, stopToken, temperature, system, user }) {
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const payload = {
    model,
    temperature,
    stop: stopToken ? [stopToken] : undefined,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const maxRetry = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        lastErr = new Error(`OpenRouter HTTP ${res.status}: ${txt.slice(0, 500)}`);
        continue;
      }

      const data = await res.json();
      if (!data.choices || !data.choices.length) {
        lastErr = new Error("No choices from OpenRouter");
        continue;
      }

      const choice = data.choices[0];
      const content = safeString(choice.message && choice.message.content);
      const finishReason = choice.finish_reason || "unknown";

      return { ok: true, content, finishReason, raw: data };
    } catch (e) {
      lastErr = e;
    }
  }

  return { ok: false, error: lastErr ? String(lastErr.message || lastErr) : "OpenRouter error" };
}

// ---- 모델 출력 파싱 ----
// 목표:
// - questionNumbers 에 있는 번호들에 대해 항상 답 하나씩 채우기
// - A~E → 1~5로 변환
// - 이상한 답(텍스트 등)은 "2번"으로 강제 + UNSURE에 포함
// - 마지막에 "UNSURE: ..." 한 줄 생성
function parseModelOutput(rawText, questionNumbers) {
  const text = safeString(rawText);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const answers = {}; // { [q]: number(1~5) }
  const unsureSet = new Set();

  for (const line of lines) {
    // UNSURE 라인
    const mUnsure = line.match(/^UNSURE\s*:\s*(.*)$/i);
    if (mUnsure) {
      const nums = mUnsure[1]
        .split(/[\s,]+/)
        .map((x) => parseInt(x, 10))
        .filter((n) => !Number.isNaN(n));
      for (const n of nums) {
        unsureSet.add(n);
      }
      continue;
    }

    // "번호: 선택지" 패턴 (강하게 우선)
    let m = line.match(/^(\d{1,3})\s*[:\-\.]?\s*([A-Ea-e1-5])/);
    if (m) {
      const q = parseInt(m[1], 10);
      let aRaw = m[2].toString().trim().toUpperCase();
      let choice = null;

      if ("ABCDE".includes(aRaw)) {
        choice = "ABCDE".indexOf(aRaw) + 1; // A→1, ..., E→5
      } else if ("12345".includes(aRaw)) {
        choice = parseInt(aRaw, 10);
      }

      if (choice !== null && choice >= 1 && choice <= 5) {
        answers[q] = choice;
        continue;
      }
    }

    // 여기까지 안 걸리면 "번호: pillaging?" 같은 이상한 형식일 수 있음
    m = line.match(/^(\d{1,3})\s*[:\-\.]?\s*(.+)$/);
    if (m) {
      const q = parseInt(m[1], 10);
      if (!Number.isNaN(q)) {
        // 형식 이상 → 기본값 2번으로 넣고 UNSURE에 추가
        if (!(q in answers)) {
          answers[q] = 2;
        }
        unsureSet.add(q);
      }
    }
  }

  // questionNumbers 기준으로 누락 채우기
  const finalAnswers = {};
  const finalUnsure = new Set(unsureSet);

  for (const q of questionNumbers) {
    if (answers[q] !== undefined) {
      finalAnswers[q] = answers[q];
    } else {
      // 모델이 아예 안 준 번호 → 2번으로 채우고 UNSURE에 넣기
      finalAnswers[q] = 2;
      finalUnsure.add(q);
    }
  }

  const sortedQs = [...questionNumbers].sort((a, b) => a - b);
  const linesOut = [];
  for (const q of sortedQs) {
    const a = finalAnswers[q];
    linesOut.push(`${q}: ${a}`);
  }

  const unsureArr = [...finalUnsure].filter((n) => questionNumbers.includes(n)).sort((a, b) => a - b);
  linesOut.push(`UNSURE: ${unsureArr.join(" ")}`);

  return {
    text: linesOut.join("\n"),
    answers: finalAnswers,
    unsure: unsureArr,
    raw: text,
  };
}

// ---- 메인 핸들러 ----
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
    const ocrText = safeString(body.ocrText || body.text || "");

    if (!ocrText.trim()) {
      return json(400, { ok: false, error: "ocrText is empty" });
    }

    // 1) 문항 번호 추출
    const questionNumbers = extractQuestionNumbers(ocrText);
    if (!questionNumbers.length) {
      // 문항 번호를 하나도 못 찾으면, 일단 에러로 돌려주자 (이 케이스는 거의 없음)
      return json(400, { ok: false, error: "No question numbers found in OCR text" });
    }

    // 2) 프롬프트 구성
    const system = [
      "너는 한국 대학 편입 영어 객관식 기출 문제를 채점하는 AI이다.",
      "입력으로 시험지 OCR 텍스트가 주어진다.",
      "반드시 다음 규칙을 지켜라.",
      "- '문항 번호 목록'에 있는 번호만 정답을 생성한다.",
      "- 각 문항에 대해 보기 중 정답 하나를 고른다.",
      "- 출력 형식은 오직 다음과 같다:",
      "  1: 3",
      "  2: 4",
      "  3: 2",
      "  ...",
      "  UNSURE: 3 10 12",
      "- 각 줄 맨 앞은 문항 번호(정수), 콜론(:), 공백, 그리고 선택지 번호(1~5) 또는 A~E 중 하나이다.",
      "- 마지막 줄은 반드시 'UNSURE:'로 시작하며, 불확실한 문항 번호들을 공백으로 나열한다. 없으면 'UNSURE:' 뒤를 비워 둔다.",
      "- 이 형식 이외의 설명, 해설, 이유, 문장은 절대 출력하지 말 것.",
      "- 매우 확신이 가지 않으면 (예: 확신도 70% 미만) 해당 문항을 UNSURE 목록에 포함시켜라.",
      "- 머릿속으로는 충분히 단계적으로 추론하되, 최종 출력에는 절대 그 과정을 드러내지 말고 형식만 지켜라.",
    ].join("\n");

    const user = [
      "다음은 편입 영어 객관식 시험지의 OCR 텍스트이다.",
      "한 지문에 문제가 여러 개 있을 수 있다.",
      "",
      "[문항 번호 목록]",
      questionNumbers.join(", "),
      "",
      "[OCR 텍스트]",
      ocrText,
      "",
      "[지시사항]",
      "- 위 OCR 텍스트와 문항 번호 목록을 기준으로, 각 문항의 정답을 선택하라.",
      "- 선택지는 보통 1~4 또는 1~5개이다. 보기 옆에 붙어 있는 번호/기호(①②③④, A~D 등)를 기준으로 정답을 판단하라.",
      "- 출력 형식을 다시 한 번 강조한다:",
      "  (예시)",
      "  1: 3",
      "  2: 4",
      "  3: 2",
      "  UN SURE: 3",
      "- 형식을 정확히 지키고, 다른 내용은 절대 출력하지 말 것.",
    ].join("\n");

    // 3) OpenRouter 호출
    const orRes = await callOpenRouter({
      apiKey,
      model,
      stopToken,
      temperature,
      system,
      user,
    });

    if (!orRes.ok) {
      return json(500, { ok: false, error: "OpenRouter call failed", detail: orRes.error });
    }

    // 4) 모델 출력 파싱 & 후처리
    const parsed = parseModelOutput(orRes.content, questionNumbers);

    const debug = {
      page,
      model,
      finishReason: orRes.finishReason,
      questionNumbers,
      answers: parsed.answers,
      unsure: parsed.unsure,
      raw: parsed.raw,
    };

    return json(200, {
      ok: true,
      text: parsed.text,
      debug,
    });
  } catch (e) {
    return json(500, { ok: false, error: "Unhandled error in solve function", detail: String(e && e.message ? e.message : e) });
  }
};
