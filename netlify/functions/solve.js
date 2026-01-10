// netlify/functions/solve.js
// -------------------------
// 역할: 편입 영어 객관식 기출 "정답만" 생성하는 함수 (중앙대 포함 전체 기출용)
// 입력: { ocrText: string, page?: number }
// 출력: { ok: true, text: "1: 2\n2: 4\n...", debug: {...} }
//
// 필요한 환경변수 (Netlify 에서 설정):
// - OPENROUTER_API_KEY  (필수, OpenRouter 키)
// - MODEL_NAME          (선택, 예: "openai/gpt-5.1", 기본값: "openai/gpt-4.1")
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

// OCR 텍스트에서 문항 번호 추출 (예: "1.", "2)", "10 ." 등)
function extractQuestionNumbers(ocrText) {
  const numbers = new Set();
  const re = /(^|\n)\s*(\d{1,3})\s*[\.\)]/g;
  let m;
  while ((m = re.exec(ocrText)) !== null) {
    const num = parseInt(m[2], 10);
    if (!Number.isNaN(num)) numbers.add(num);
  }
  return Array.from(numbers).sort((a, b) => a - b);
}

// "A, B, C, D, E / 1,2,3,4,5 / 3번" 등 → 숫자(1~5)로 정규화
function normalizeAnswerToNumber(raw) {
  if (!raw) return null;
  const text = String(raw).trim();

  // 정확히 1~5만 있는 경우
  let m = text.match(/^\(?\s*([1-5])\s*\)?$/);
  if (m) return parseInt(m[1], 10);

  // A~E 포함된 경우
  m = text.match(/[A-E]/i);
  if (m) {
    const ch = m[0].toUpperCase();
    const map = { A: 1, B: 2, C: 3, D: 4, E: 5 };
    if (map[ch]) return map[ch];
  }

  // 안에 숫자(1~5)가 섞여 있으면 첫 번째 숫자 사용
  m = text.match(/[1-5]/);
  if (m) return parseInt(m[0], 10);

  // 알 수 없음
  return null;
}

// OpenRouter 호출 (Netlify Node 18+ 에서는 fetch 전역으로 있음)
async function callOpenRouter({ apiKey, model, stopToken, temperature, systemPrompt, userPrompt }) {
  const url = "https://openrouter.ai/api/v1/chat/completions";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
      "X-Title": "answer-site solver",
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: 800,
      stop: [stopToken],
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenRouter HTTP ${res.status} ${res.statusText} ${txt}`);
  }

  const data = await res.json();
  const choice = data.choices && data.choices[0];
  const finishReason = choice && choice.finish_reason;
  const content = choice && choice.message && choice.message.content;
  const text = Array.isArray(content)
    ? content.map((p) => (typeof p === "string" ? p : p.text || "")).join("")
    : (content || "");

  return { text, finishReason };
}

// 모델 응답 post-processing:
// - knownNumbers(문항 번호 목록)를 기준으로 정리
// - 정답은 항상 "번호: 숫자(1~5)" 형식으로 강제
// - 숫자로 못 바꾸는 이상한 답은 모두 2번으로 교정 + UNSURE에 추가
function postProcessCompletion(rawText, knownNumbers) {
  const text = String(rawText || "");
  const lines = text.split(/\r?\n/);

  const knownSet = new Set(
    (knownNumbers || []).filter((n) => Number.isInteger(n))
  );

  const answers = {};
  const unsureSet = new Set();

  // 1) 모델이 준 UNSURE 라인 먼저 수집
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^UNSURE\s*:\s*(.+)$/i);
    if (m) {
      const parts = m[1]
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of parts) {
        const num = parseInt(p, 10);
        if (!Number.isNaN(num)) {
          if (!knownSet.size || knownSet.has(num)) {
            unsureSet.add(num);
          }
        }
      }
    }
  }

  // 2) 각 줄에서 "번호: 정답" 패턴 파싱
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = line.match(/^(\d{1,3})\s*[:\-]\s*(.+)$/);
    if (!m) continue;

    const num = parseInt(m[1], 10);
    if (!Number.isInteger(num)) continue;
    if (knownSet.size && !knownSet.has(num)) continue;

    const ansRaw = m[2].trim();
    const numeric = normalizeAnswerToNumber(ansRaw);

    if (numeric == null) {
      // 이상한 답 → 2번으로 교정 + UNSURE에 추가
      answers[num] = 2;
      unsureSet.add(num);
    } else {
      answers[num] = numeric;
    }
  }

  // 3) 정답이 비어 있는 번호에 대해서도 안전하게 채워넣기 (기본 2번 + UNSURE)
  const finalNums = (knownNumbers && knownNumbers.length
    ? Array.from(new Set(knownNumbers))
    : Object.keys(answers).map((x) => parseInt(x, 10))
  ).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);

  for (const num of finalNums) {
    if (!(num in answers)) {
      answers[num] = 2;
      unsureSet.add(num);
    }
  }

  // 4) 최종 출력 문자열 생성
  const outLines = [];
  for (const num of finalNums) {
    outLines.push(`${num}: ${answers[num]}`);
  }

  let unsureLine = "UNSURE:";
  if (unsureSet.size) {
    const arr = Array.from(unsureSet).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
    if (arr.length) {
      unsureLine = `UNSURE: ${arr.join(" ")}`;
    }
  }

  const finalText = outLines.join("\n") + "\n" + unsureLine;

  return {
    text: finalText,
    answers,
    unsure: Array.from(unsureSet).filter((n) => Number.isInteger(n)).sort((a, b) => a - b),
  };
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

    const page = Number.isFinite(Number(body.page)) ? Number(body.page) : 1;
    const ocrTextRaw = body.ocrText || body.text || "";
    const ocrText = String(ocrTextRaw || "").trim();

    if (!ocrText) {
      return json(400, { ok: false, error: "ocrText is empty" });
    }

    // OCR 텍스트에서 문항 번호 추출
    const questionNumbers = extractQuestionNumbers(ocrText);

    // 시스템 프롬프트 (규칙)
    const systemPrompt = `
너는 편입 영어 객관식 기출 문제 채점/정답키 생성용 AI이다.

- 입력은 OCR로 인식된 시험지 텍스트이다.
- 지문/문항/선지(A~E, ①~⑤, 1~5)는 한국어/영어/혼합일 수 있다.
- 너의 최종 목표는 "각 문항 번호에 대해 정답 보기 번호만" 생성하는 것이다.

[출력 형식 규칙 – 아주 중요]
1) 각 문항은 한 줄에 하나씩만:
   "<문항번호>: <정답번호>" 형식으로 출력한다.
   예) "1: 2", "13: 4"
2) <정답번호>는 반드시 1, 2, 3, 4, 5 중 하나인 숫자만 사용한다.
   - 절대 A,B,C,D,E 같은 알파벳이나 영어 단어(예: pillaging, unlike 등)를 쓰지 말 것.
   - "1번", "2번"처럼 '번'을 붙이지 말고, 오직 숫자로만.
3) 출력 마지막 줄은 항상
   "UNSURE: ..." 형식으로, 너가 특히 자신 없는 번호들을 공백으로 구분해 나열한다.
   - 예) "UNSURE: 7 10 11"
   - 특별히 불확실한 번호가 없다면 "UNSURE:" 만 출력한다.

[채점 원칙]
- 오답을 최소화해야 한다.
- 하지만, 너무 확신이 안 가는 번호는 정답 추측은 하되 UNSURE 목록에 반드시 포함한다.
- 보기 수가 4개인 시험지는 1~4 중에서, 5개인 시험지는 1~5 중에서 가장 가능성 높은 것을 고른다.
- 보기 텍스트를 그대로 출력하지 말고, 항상 보기 번호(숫자)만 출력한다.
- 설명/해설/근거/요약/기타 문장은 절대 쓰지 말고, 정답 라인들과 UNSURE 라인만 출력한다.
`.trim();

    // 사용자 프롬프트: OCR 텍스트 + 문항 번호 정보
    const userPromptParts = [];

    userPromptParts.push("다음은 OCR로 인식된 편입 영어 객관식 시험지의 일부이다.");
    userPromptParts.push("");
    userPromptParts.push("=== OCR TEXT START ===");
    userPromptParts.push(ocrText);
    userPromptParts.push("=== OCR TEXT END ===");
    userPromptParts.push("");

    if (questionNumbers.length) {
      userPromptParts.push(
        `위 텍스트에서 인식된 문항 번호: ${questionNumbers.join(", ")}`
      );
      userPromptParts.push(
        "위에 나열된 문항 번호 각각에 대해, 보기 내용을 분석해서 가장 가능성 높은 정답 번호(1~5)만 골라라."
      );
      userPromptParts.push(
        "각 줄은 '<문항번호>: <정답번호>' 형식으로, 마지막 줄은 'UNSURE: ...' 형식으로 출력하라."
      );
    } else {
      userPromptParts.push(
        "위 텍스트에서 문항 번호 패턴을 스스로 찾아서, 등장하는 각 문항에 대해 정답 번호(1~5)만 골라라."
      );
      userPromptParts.push(
        "각 줄은 '<문항번호>: <정답번호>' 형식으로, 마지막 줄은 'UNSURE: ...' 형식으로 출력하라."
      );
    }

    const userPrompt = userPromptParts.join("\n");

    // OpenRouter 호출
    const { text: rawCompletion, finishReason } = await callOpenRouter({
      apiKey,
      model,
      stopToken,
      temperature,
      systemPrompt,
      userPrompt,
    });

    // 모델 응답을 후처리: 숫자(1~5)만 남기고, 이상한 답은 2번 + UNSURE로 교정
    const processed = postProcessCompletion(rawCompletion, questionNumbers);

    return json(200, {
      ok: true,
      text: processed.text,
      debug: {
        page,
        model,
        finishReason,
        questionNumbers,
        answers: processed.answers,
        unsure: processed.unsure,
        raw: rawCompletion,
      },
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "Unhandled error in solve function",
      detail: err && err.message ? err.message : String(err),
    });
  }
};
