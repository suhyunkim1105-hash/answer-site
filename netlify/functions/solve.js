// netlify/functions/solve.js
// --------------------------------------
// 역할: 편입 영어 객관식 기출 "정답번호만" 생성하는 함수
// 입력: { ocrText: string, page?: number }
// 출력: { ok: true, text: "1: 4\n2: 3\n...", debug: {...} }
//
// 환경변수 (Netlify):
// - OPENROUTER_API_KEY  (필수)
// - MODEL_NAME          (선택, 예: "openai/gpt-4.1")
// - TEMPERATURE         (선택, 기본 0.0)
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

// LLM이 준 텍스트에서 "번호: 선택지" + UNSURE 목록만 추출
function parseModelAnswers(rawText) {
  const answers = {};
  const unsureSet = new Set();

  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (const line of lines) {
    // "12: 3" 또는 "12-3" 형식
    const m = line.match(/^(\d{1,3})\s*[:\-]\s*([1-4])\s*(\?)?$/);
    if (m) {
      const q = Number(m[1]);
      const a = Number(m[2]);
      answers[q] = a;
      if (m[3]) unsureSet.add(q);
      continue;
    }

    // "UNSURE: 3 5 12"
    const u = line.match(/^UNSURE\s*:\s*(.*)$/i);
    if (u) {
      const rest = u[1] || "";
      for (const token of rest.split(/[\s,]+/)) {
        if (!token) continue;
        const n = Number(token);
        if (!Number.isNaN(n)) unsureSet.add(n);
      }
    }
  }

  const unsure = Array.from(unsureSet).sort((a, b) => a - b);
  return { answers, unsure, raw: String(rawText || "") };
}

// "1: 4\n2: 3\n...\nUNSURE: 10 11" 형식으로 다시 렌더링
function renderOutput(answers, unsure) {
  const qs = Object.keys(answers)
    .map((n) => Number(n))
    .sort((a, b) => a - b);

  const lines = [];
  for (const q of qs) {
    const a = answers[q];
    if (!a) continue;
    lines.push(`${q}: ${a}`);
  }

  if (unsure && unsure.length > 0) {
    lines.push(`UNSURE: ${unsure.join(" ")}`);
  } else {
    lines.push("UNSURE:");
  }

  return lines.join("\n");
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
    const temperature = Number(
      process.env.TEMPERATURE === undefined ? 0.0 : process.env.TEMPERATURE
    );

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const ocrTextRaw = body.ocrText || body.text || "";
    const ocrText = String(ocrTextRaw || "").trim();

    if (!ocrText) {
      // OCR이 비었으면 모델을 호출해도 의미 없으니 바로 실패 반환
      return json(400, { ok: false, error: "ocrText is empty" });
    }

    // 시스템 프롬프트: 한/영 섞어서 매우 엄격하게 포맷 지시
    const systemPrompt =
      [
        "너는 '편입영어 객관식 기출 채점/정답키 생성' 전용 AI다.",
        "",
        "[최우선 목표]",
        "1) 오답 최소화 (정답률 극대화)",
        "2) 보이는 문항번호는 절대 누락하지 말 것 (문항 누락 0)",
        "3) 출력은 오직 정답번호만: 한 줄에 하나 '문항번호: 선택지번호' (예: '13: 2')",
        "4) 불확실한 문항은 임의로 비워두지 말고, 가장 가능성 높은 번호를 선택한 뒤 UNSURE 목록에 추가한다.",
        "   - 예: 13번이 애매하면 본문에는 '13: 2'라고 쓰고, 마지막 줄에 'UNSURE: 13'이라고 적는다.",
        "5) 그 외 어떤 설명/해설/머리말/구분선/마크다운도 절대 출력하지 말 것.",
        "",
        "[포맷 규칙 – 지켜야 할 것만]",
        "1) 정답 줄 형식: '문항번호: 선택지번호'",
        "   - 예시: '1: 4', '10: 2'",
        "   - 선택지번호는 1,2,3,4 중 하나인 숫자만 써라. (A,B,C,D, 단어, 기호, 영어단어 모두 금지)",
        "2) 마지막 줄은 항상 'UNSURE: ...' 형식으로 끝낸다.",
        "   - 애매한 번호가 없으면 'UNSURE:' 만 출력.",
        "   - 있으면 'UNSURE: 3 5 12' 처럼 공백으로 번호만 나열.",
        "3) 물음표( ? )나 괄호, 영어 단어, 심볼을 정답 줄에 섞지 마라.",
        "   - 나쁜 예: '7: pillaging?', '24: D', '11: C (maybe)'",
        "   - 좋은 예: '7: 2', '24: 3'",
        "",
        "[풀이 내부 절차(생각은 네가 알아서 하고, 출력은 위 포맷만 사용)]",
        "1) OCR 텍스트에서 문항번호(1, 2, 3, ...), 지문, 선택지를 모두 모은다.",
        "2) 같은 페이지에 여러 세트(예: [1-7], [8-9], [10-12])가 섞여 있어도 모두 처리한다.",
        "3) 각 문항에 대해 지문과 선택지를 끝까지 읽고, 가장 타당한 보기를 1~4 중 하나로 고른다.",
        "4) '보이는 문항번호'는 모두 답을 찍는다. 절대 건너뛰지 말 것.",
        "5) 매우 애매한 경우에도 가장 가능성이 높은 번호를 하나 고르고, 그 번호를 UNSURE 목록에 따로 표시한다.",
        "",
        "이제부터 어떤 추가 설명도 하지 말고, 오직 정답과 UNSURE 줄만 출력해라."
      ].join("\n");

    const userPrompt =
      [
        `다음은 편입 영어 시험지의 OCR 텍스트다. (page ${page})`,
        "",
        "=== OCR TEXT ===",
        ocrText,
        "=== END ===",
        "",
        "위 시험지에서 보이는 모든 객관식 문항에 대해 정답만 출력해라.",
        "출력 형식은 아래 예시를 100% 그대로 따른다.",
        "",
        "1: 4",
        "2: 3",
        "3: 1",
        "UNSURE: 2 3",
        "",
        "위 예시는 단지 형식 예시일 뿐 실제 정답이 아니다. 실제 문제를 보고 네가 판단한 정답번호로 채워 넣어라."
      ].join("\n");

    const payload = {
      model,
      temperature,
      stop: [stopToken],
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site-solve",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return json(response.status, {
        ok: false,
        error: `OpenRouter API error: ${response.status}`,
        detail: text,
      });
    }

    const data = await response.json().catch(() => null);
    if (!data || !data.choices || !data.choices[0] || !data.choices[0].message) {
      return json(502, { ok: false, error: "Invalid OpenRouter response" });
    }

    const message = data.choices[0].message;
    const content = typeof message.content === "string"
      ? message.content
      : (Array.isArray(message.content)
          ? message.content.map((c) => (typeof c === "string" ? c : c.text || "")).join("\n")
          : "");

    const { answers, unsure, raw } = parseModelAnswers(content);
    const text = renderOutput(answers, unsure);

    return json(200, {
      ok: true,
      text,
      debug: {
        page,
        model,
        finishReason: data.choices[0].finish_reason || data.choices[0].finishReason,
        answers,
        unsure,
        raw,
      },
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "solve.js runtime error",
      detail: String(err && err.stack ? err.stack : err),
    });
  }
};
