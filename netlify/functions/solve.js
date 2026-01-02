// netlify/functions/solve.js
// ✅ OCR 텍스트 정규화(최소세트) + 섹션 탐지 + 문법(06-10) 전용 입력 강화
// ✅ 답은 무조건 다 출력(빈칸/문법/어휘) + 마지막에 UNSURE 리스트
// 입력: JSON { page, ocrText }

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return j(405, { ok: false, error: "POST only" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return j(500, { ok: false, error: "OPENROUTER_API_KEY is not set" });

    const model = String(process.env.MODEL_NAME || "openai/gpt-5.1");
    const stopToken = String(process.env.STOP_TOKEN || "XURTH");
    const temperature = Number(process.env.TEMPERATURE ?? 0);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return j(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page !== undefined ? body.page : 1;
    const ocrTextRaw = String(body.ocrText || body.text || "");
    if (!ocrTextRaw.trim()) return j(400, { ok: false, error: "Missing ocrText" });

    // 1) 정규화(최소세트)
    const ocrText = normalizeOcr(ocrTextRaw);

    // 2) 문법(06-10) 섹션만 따로 뽑아서 “문장 단위”로 입력 강화
    const grammar = extractGrammar0610(ocrText);

    // 3) 모델 입력: 전체 + (문법 전용 블록이 있으면) 문법 블록을 별도로 강조
    const system = [
      "You are a strict exam answerer.",
      "You must output answers for ALL questions you can see.",
      "Never output '-' for an answer. Always choose one option even if uncertain.",
      "",
      "Output format (MUST):",
      "1: A",
      "2: 3",
      "3: E",
      "...",
      `At the end, output: UNSURE: comma-separated question numbers (or empty)`,
      `Then output exactly the stop token on its own line: ${stopToken}`,
      "",
      "Rules:",
      "- For vocabulary/blank questions with options A–E: answer must be one of A,B,C,D,E.",
      "- For grammar error questions (06–10): answer must be a number 1–5 (error position).",
      "- If OCR structure is messy, use best judgment and still answer.",
      "- If you are not confident, include that question number in UNSURE but STILL answer it.",
      "",
      "Important: SKKU grammar section is 'Choose one that is either ungrammatical or unacceptable' and asks for ONE error position among 1–5.",
    ].join("\n");

    const userParts = [];
    userParts.push(`PAGE: ${page}`);
    userParts.push("");
    if (grammar && grammar.items.length) {
      userParts.push("=== GRAMMAR 06-10 (cleaned, each sentence has markers A–E; choose error position 1–5) ===");
      for (const it of grammar.items) {
        userParts.push(`Q${it.q}: ${it.text}`);
      }
      userParts.push("");
    }
    userParts.push("=== FULL OCR (normalized) ===");
    userParts.push(ocrText);

    const user = userParts.join("\n");

    const content = await callOpenRouter({
      apiKey,
      model,
      temperature,
      stopToken,
      system,
      user,
    });

    const parsed = parseAnswers(content, stopToken);

    // answers: { "1": {raw:"B", num:2}, "6": {raw:"4", num:4} ... }
    const questionNumbers = Object.keys(parsed.answers)
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

    const outLines = [];
    for (const n of questionNumbers) {
      const a = parsed.answers[String(n)];
      outLines.push(`${n}: ${a.raw}`);
    }
    outLines.push(`UNSURE: ${parsed.unsure.join(",")}`);
    outLines.push(stopToken);

    return j(200, {
      ok: true,
      text: outLines.join("\n"),
      debug: {
        page,
        model,
        questionNumbers,
        answers: Object.fromEntries(
          Object.entries(parsed.answers).map(([k, v]) => [k, v.num])
        ),
        finishReason: "stop",
        stopToken,
        ocrTextPreview: ocrText.slice(0, 600),
        grammarDetected: grammar ? grammar.items.map((x) => x.q) : [],
      },
    });
  } catch (err) {
    return j(500, {
      ok: false,
      error: "Internal server error in solve function",
      detail: String(err?.message || err),
    });
  }
};

function j(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

/**
 * ✅ 정규화 최소세트
 * - ①②③④⑤ => (A)(B)(C)(D)(E)
 * - ‹ › < > 등 잡기호 제거/정리
 * - O4/O7/0909 같은 번호 흔들림 보정
 * - (A) / A, / A. / <A ...> 모두 “(A)”로 통일
 */
function normalizeOcr(s) {
  let t = String(s || "");

  // 줄바꿈 정리
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 특수 따옴표/브래킷 통일
  t = t
    .replace(/[‹›]/g, '"')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  // ①②③④⑤ -> (A)(B)(C)(D)(E)
  t = t
    .replace(/①/g, "(A)")
    .replace(/②/g, "(B)")
    .replace(/③/g, "(C)")
    .replace(/④/g, "(D)")
    .replace(/⑤/g, "(E)");

  // <A ...>, ‹A ...›, (A ...), A, A. 등 -> (A)
  // 1) "<A" 형태
  t = t.replace(/<\s*([A-E])\s*/g, "($1) ");
  // 2) "A," "B." 같은 형태
  t = t.replace(/(^|\n)\s*([A-E])\s*[,.)]\s*/g, "$1($2) ");
  // 3) "(A" 형태 공백 보정
  t = t.replace(/\(\s*([A-E])\s*\)/g, "($1)");

  // 남은 < > 제거
  t = t.replace(/[<>]/g, " ");

  // O4 -> 04, O7 -> 07 (알파벳 O + 숫자)
  t = t.replace(/\bO([0-9])\b/g, "0$1");

  // 0909 -> 09 09, 0707 -> 07 07 (붙은 번호 분리)
  t = t.replace(/\b(0[1-9]|10|11|12|13|14|15|16|17|18|19|20)\1\b/g, "$1 $1");

  // 이상한 구분 기호 정리
  t = t.replace(/[|·•]/g, " ");

  // 다중 공백 정리
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

/**
 * 문법 06-10 섹션 추출:
 * - 헤더: "ungrammatical or unacceptable" 기준
 * - 다음 섹션: "[11-20]" or "most appropriate for the blank" 등 나오면 끊음
 */
function extractGrammar0610(text) {
  const lower = text.toLowerCase();

  const headIdx = lower.search(/ungrammatical\s+or\s+unacceptable/);
  if (headIdx < 0) return { items: [] };

  const tailCandidates = [
    lower.search(/\[?\s*11\s*-\s*20\s*\]?\s*choose\s+one\s+that\s+is\s+most\s+appropriate/i),
    lower.search(/most\s+appropriate\s+for\s+the\s+blank/i),
  ].filter((x) => x >= 0);

  const tailIdx =
    tailCandidates.length ? Math.min(...tailCandidates.filter((x) => x > headIdx)) : -1;

  const block = (tailIdx > headIdx ? text.slice(headIdx, tailIdx) : text.slice(headIdx)).trim();

  const items = [];
  for (const q of [6, 7, 8, 9, 10]) {
    const seg = sliceQuestionBlock(block, q, q === 10 ? null : q + 1);
    if (!seg) continue;

    // 마커를 더 “보기 좋게” 강제: (A)~(E) 앞뒤 띄어쓰기
    let cleaned = seg
      .replace(/\(\s*([A-E])\s*\)/g, "[$1]") // 모델 입력은 [A] 형태가 더 안정적
      .replace(/\s+\]/g, "]")
      .replace(/\[\s+/g, "[")
      .replace(/[ ]{2,}/g, " ")
      .trim();

    // 너무 짧거나 깨졌으면 제외
    if (cleaned.length < 20) continue;

    // 만약 [A]~[E]가 부족하면(=OCR이 못 줌) 그래도 보내되, 모델이 추론하게 둠
    items.push({ q, text: cleaned });
  }

  return { items };
}

// block에서 q번 문항 텍스트 잘라오기
function sliceQuestionBlock(block, q, nextQ) {
  const qStr = String(q).padStart(2, "0");
  const nextStr = nextQ ? String(nextQ).padStart(2, "0") : null;

  // 시작 패턴: "\n06 06." or "\n06." 등
  const startRe = new RegExp(`(^|\\n)\\s*${qStr}\\s*(?:${qStr})?\\s*[.)]`, "i");
  const m = startRe.exec(block);
  if (!m) return null;
  const start = m.index + (m[1] ? m[1].length : 0);

  let end = block.length;
  if (nextStr) {
    const endRe = new RegExp(`\\n\\s*${nextStr}\\s*(?:${nextStr})?\\s*[.)]`, "i");
    const m2 = endRe.exec(block.slice(start));
    if (m2) end = start + m2.index;
  }

  return block.slice(start, end).trim();
}

async function callOpenRouter({ apiKey, model, temperature, stopToken, system, user }) {
  const url = "https://openrouter.ai/api/v1/chat/completions";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Title": "answer-site",
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // stop 토큰 강제
      stop: [stopToken],
    }),
  });

  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`OpenRouter HTTP ${res.status}: ${raw.slice(0, 300)}`);
  }

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("OpenRouter returned non-JSON");
  }

  const content =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    "";

  return String(content || "");
}

function parseAnswers(modelText, stopToken) {
  let t = String(modelText || "");
  // stopToken 앞까지만
  const idx = t.indexOf(stopToken);
  if (idx >= 0) t = t.slice(0, idx);

  const lines = t.split("\n").map((x) => x.trim()).filter(Boolean);

  const answers = {};
  const unsureSet = new Set();

  for (const line of lines) {
    // "UNSURE: 6,7,8"
    const um = line.match(/^UNSURE\s*:\s*(.*)$/i);
    if (um) {
      const arr = um[1]
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => x.replace(/[^0-9]/g, ""))
        .filter(Boolean);
      for (const n of arr) unsureSet.add(Number(n));
      continue;
    }

    // "6: 4" or "1: B"
    const m = line.match(/^(\d{1,2})\s*:\s*([A-Ea-e]|[1-5])\b/);
    if (!m) continue;

    const q = String(Number(m[1]));
    const raw = String(m[2]).toUpperCase();

    let num = 0;
    if (raw >= "A" && raw <= "E") num = raw.charCodeAt(0) - "A".charCodeAt(0) + 1;
    else num = Number(raw);

    answers[q] = { raw, num };
  }

  // ✅ "답은 다 내기" 강제: 1~20 중 빠진 건 모델이 안 줬을 가능성 → 임의 채움(UNSURE에 넣음)
  // (네가 목표 98%라서 '-' 금지. 누락은 바로 정답률 박살이라서 이렇게라도 막음)
  // 단, 실제 시험이 1~50이더라도 페이지마다 1~20만 잡히는 경우가 많아서 기본은 1~20만 채움.
  const target = [];
  for (let i = 1; i <= 20; i++) target.push(i);

  for (const qn of target) {
    const k = String(qn);
    if (!answers[k]) {
      // 문법(06-10)은 1~5 숫자, 그 외는 A~E
      if (qn >= 6 && qn <= 10) answers[k] = { raw: "3", num: 3 };
      else answers[k] = { raw: "C", num: 3 };
      unsureSet.add(qn);
    }
  }

  const unsure = Array.from(unsureSet).sort((a, b) => a - b);

  return { answers, unsure };
}

