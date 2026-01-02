// netlify/functions/solve.js
// 목표: (1) 문항번호 감지 안정화(2단 OCR 합쳐짐 포함) (2) 무조건 답 출력 (3) UNSURE 유지 (4) A-E/1-5 모두 정규화

const VERSION = "solve.v3.1.0";

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST only" }, 405);
  }

  const startedAt = Date.now();

  try {
    const body = await request.json();
    const page = Number(body?.page || 1);
    const rawText = String(body?.text || "");

    const normText = normalizeOcrText(rawText);
    const detected = detectQuestionNumbers(normText);

    // fallback window when detection is weak
    const target = chooseTargetNumbers({ detected, page });

    const model = process.env.MODEL_NAME || "openai/gpt-5.1";
    const apiKey = process.env.OPENROUTER_API_KEY;
    const stopToken = process.env.STOP_TOKEN || "XURTH";
    const temperature = Number(process.env.TEMPERATURE ?? 0);

    if (!apiKey) return json({ ok: false, error: "OPENROUTER_API_KEY missing" }, 500);

    const prompt = buildPrompt({ page, target, stopToken, normText });

    const controller = new AbortController();
    // Netlify sync functions: default 60s limit (keep margin). :contentReference[oaicite:1]{index=1}
    const timeoutMs = 50000;
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: prompt,
        stop: [stopToken],
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(t));

    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      return json({ ok: false, error: `OpenRouter HTTP ${res.status}`, raw: data }, 500);
    }

    const content = (data.choices?.[0]?.message?.content || "").trim();
    const parsed = parseModelOutput(content, target);

    const elapsedMs = Date.now() - startedAt;

    return json({
      ok: true,
      text: parsed.finalText,
      debug: {
        version: VERSION,
        page,
        model,
        detected,
        target,
        unsure: parsed.unsure,
        elapsedMs,
        // small preview for sanity
        ocrPreview: normText.slice(0, 600),
      }
    });

  } catch (e) {
    const msg = e?.name === "AbortError" ? "solve timeout" : (e?.message || String(e));
    return json({ ok: false, error: msg }, 500);
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function normalizeOcrText(s) {
  let t = String(s || "");

  // normalize weird brackets and quotes
  t = t
    .replace(/[‹›«»]/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'");

  // OCR often produces: O4 for 04
  t = t.replace(/\bO(\d)\b/g, "0$1");

  // fix glued question numbers like 0505. / 0707.
  t = t.replace(/\b(0[1-9]|[1-4]\d|50)(0[1-9]|[1-4]\d|50)\./g, (m, a, b) => {
    if (a === b) return `${a} ${b}.`;
    return m;
  });

  // unify spacing
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

function detectQuestionNumbers(t) {
  const nums = new Set();

  // [01-05] style ranges
  const rangeRe = /\[(\d{2})\s*-\s*(\d{2})\]/g;
  for (const m of t.matchAll(rangeRe)) {
    const a = Number(m[1]), b = Number(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && a >= 1 && b <= 50 && a <= b) {
      for (let i = a; i <= b; i++) nums.add(i);
    }
  }

  // "01 01." / "13. 13." / "16.16." ANYWHERE (2단 OCR 합쳐짐 대응)
  // 안전장치: 쉼표(13,000)와 구분되도록 '.' 패턴만 인정
  const dupRe = /\b(0?[1-9]|[1-4]\d|50)\s*(?:\.\s*|\s+)(0?[1-9]|[1-4]\d|50)\s*\./g;
  for (const m of t.matchAll(dupRe)) {
    const a = Number(m[1]), b = Number(m[2]);
    // 보통 a==b가 문항번호. 그래도 a만 사용(일부 OCR이 두 번째를 깨먹음)
    if (a >= 1 && a <= 50) nums.add(a);
    if (b >= 1 && b <= 50 && a === b) nums.add(b);
  }

  // line-start "18." patterns (보조)
  const lineRe = /(?:^|\n)\s*(0?[1-9]|[1-4]\d|50)\s*\.(?!\d)/g;
  for (const m of t.matchAll(lineRe)) {
    const a = Number(m[1]);
    if (a >= 1 && a <= 50) nums.add(a);
  }

  return Array.from(nums).sort((x, y) => x - y);
}

function chooseTargetNumbers({ detected, page }) {
  // if detection is decent, trust it
  if (detected.length >= 5) return detected;

  // if user shot partial page (like 13~19), detected can be small but still meaningful
  if (detected.length >= 2) return detected;

  // hard fallback by page
  if (page === 1) return range(1, 20);
  if (page === 2) return range(21, 40);
  if (page === 3) return range(41, 50);
  // generic fallback
  return range(1, 20);
}

function range(a, b) {
  const out = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

function buildPrompt({ page, target, stopToken, normText }) {
  const targetList = target.join(", ");

  // “성균관대 문법 유형 약간만” + “답 무조건” + “정규화 최소세트”
  const system = `
너는 "성균관대 영어 편입" 객관식 정답 키 생성기다.
최우선 목표: 오답 최소화 + 하지만 무응답 금지(모든 문항에 1~5 중 하나는 반드시 선택).

정규화 규칙(최소):
- 보기 A/B/C/D/E는 각각 1/2/3/4/5로 간주한다.
- 문법오류(Choose one that is either ungrammatical or unacceptable) 유형은 문장 내 표시된 ①~⑤(또는 A~E) 중 '오류/부적절'한 부분 하나를 고르는 문제이며, 최종 출력은 1~5로만 한다.
- 확신이 낮아도 답은 내되, 마지막 줄에 UNSURE: 문항번호들을 쉼표로 나열한다.

문법오류에서 자주 나오는 포인트(최소):
- include/avoid/consider 등 뒤 동명사/부정사 형태
- 병렬(parallelism): to V / V-ing / 명사 형태 일치
- 대명사 지시/수일치(its/their, he/they 등)
- 전치사/관계사(where/which) 용법
- 수일치/시제/태(수동·능동)

출력 형식(설명 금지):
각 줄: "문항번호-정답" (정답은 1~5)
마지막에서 두 번째 줄: "UNSURE: ..." (없으면 빈칸 대신 UNSURE: 없음)
마지막 줄: ${stopToken}
`.trim();

  const user = `
[페이지] ${page}
[풀어야 할 문항 번호들] ${targetList}

[OCR 텍스트 원문]
${normText}
`.trim();

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parseModelOutput(content, target) {
  const answers = new Map();
  const unsure = new Set();

  // capture UNSURE list
  const unsureMatch = content.match(/UNSURE\s*:\s*([0-9,\s]+)/i);
  if (unsureMatch && unsureMatch[1]) {
    for (const part of unsureMatch[1].split(",")) {
      const n = Number(part.trim());
      if (Number.isFinite(n)) unsure.add(n);
    }
  }

  // parse lines: "13-2", "13 : B", "13) 2" etc.
  const lineRe = /(?:^|\n)\s*(0?[1-9]|[1-4]\d|50)\s*[-:)\.]\s*([1-5]|[A-Ea-e])\b/g;
  for (const m of content.matchAll(lineRe)) {
    const q = Number(m[1]);
    let a = m[2].toUpperCase();
    let v = letterToNum(a);
    if (!v) v = Number(a);
    if (q >= 1 && q <= 50 && v >= 1 && v <= 5) answers.set(q, v);
  }

  // fill missing with "best guess" = 3, but mark as unsure
  for (const q of target) {
    if (!answers.has(q)) {
      answers.set(q, 3);
      unsure.add(q);
    }
  }

  // build final output strictly for target, sorted
  const sorted = [...target].sort((a,b)=>a-b);
  let out = "";
  for (const q of sorted) {
    out += `${q}-${answers.get(q)}\n`;
  }

  const unsureArr = [...unsure].filter(n => target.includes(n)).sort((a,b)=>a-b);
  out += `UNSURE: ${unsureArr.length ? unsureArr.join(", ") : "없음"}\n`;
  out += `${process.env.STOP_TOKEN || "XURTH"}`;

  return { finalText: out.trim(), unsure: unsureArr };
}

function letterToNum(ch) {
  if (ch === "A") return 1;
  if (ch === "B") return 2;
  if (ch === "C") return 3;
  if (ch === "D") return 4;
  if (ch === "E") return 5;
  return 0;
}
