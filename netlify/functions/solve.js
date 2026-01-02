// netlify/functions/solve.js
// 입력: { page, ocrText }
// 출력: { ok, text, model, usedNumbers, unsure }

const fetch = globalThis.fetch;

function normalizeOcrMinimal(s) {
  if (!s) return "";
  let t = String(s)
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐-‒–—]/g, "-")
    .replace(/[<>〔〕【】]/g, " ") // OCR이 꺾쇠로 섞어버리는 경우 완화
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  // 1) "16.16." 같은 중복번호 → "16."
  t = t.replace(/\b(\d{1,2})\.\s*\1\./g, "$1.");

  // 2) "11.17." 같이 번호가 붙어서 나오는 케이스 → 줄바꿈 삽입
  //    (단, 13.000 같은 소수/천단위와 겹치지 않게: "숫자.숫자." 형태만)
  t = t.replace(/\b(\d{1,2})\.(\d{1,2})\./g, (m, a, b) => `${a}.\n${b}.`);

  // 3) "O4"처럼 알파 O로 들어오는 케이스
  t = t.replace(/\bO(\d)\b/g, "$1");

  return t.trim();
}

function detectSectionTargetNumbers(text) {
  // 1) 헤더가 있으면 그걸 최우선
  const header = text.match(/\[(\d{1,2})\s*-\s*(\d{1,2})\]/);
  if (header) {
    const a = Number(header[1]), b = Number(header[2]);
    if (a >= 1 && b <= 50 && a < b) {
      return range(a, b);
    }
  }

  // 2) 숫자 감지 기반으로 섹션 추정
  const nums = extractQuestionNumbers(text);
  const has11to20 = nums.some(n => n >= 11 && n <= 20);
  const has1to10 = nums.some(n => n >= 1 && n <= 10);

  // 성균관대 영어는 보통 1~20이 1페이지에 몰리는 경우가 많아서
  // 11~20이 보이면 11~20으로 강제하는 게 누락 방지에 유리함
  if (has11to20) return range(11, 20);
  if (has1to10) return range(1, 10);

  // 감지 실패 시 최소 안전: 1~20
  return range(1, 20);
}

function range(a, b) {
  const out = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

function extractQuestionNumbers(text) {
  // 줄 시작/줄 중간 모두에서 "13." 같은 패턴을 최대한 잡음
  const re = /(?:^|\n|\s)(\d{1,2})\s*\./g;
  const seen = new Set();
  let m;
  while ((m = re.exec(text))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 50) seen.add(n);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

function buildBlocks(text, targetNumbers) {
  // targetNumbers 위치 찾아서 block 잘라내기
  const positions = [];
  for (const n of targetNumbers) {
    // "13." 또는 "13 ." 또는 "13. 13." 같은 케이스 포함
    const re = new RegExp(`(?:^|\\n|\\s)(${n})\\s*\\.`, "g");
    const m = re.exec(text);
    if (m) positions.push({ n, idx: m.index });
  }
  positions.sort((a, b) => a.idx - b.idx);

  const blocks = new Map();
  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i];
    const next = positions[i + 1];
    const start = cur.idx;
    const end = next ? next.idx : Math.min(text.length, start + 4000); // 너무 길면 컷
    const chunk = text.slice(start, end).trim();
    blocks.set(cur.n, chunk);
  }
  return blocks;
}

function guessDefaultForNumber(n) {
  // 기본 찍기값 (너가 말한 "무조건 답" 원칙)
  // 보통 ①~⑤에서 ③이 중앙값이라 최소 손해 전략
  return "3";
}

function parseModelAnswers(raw, targetNumbers) {
  const ans = new Map();
  const unsure = new Set();

  const lines = String(raw || "").split(/\n+/).map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    // "14: 3" 또는 "14 - 3" 또는 "14) 3"
    const m = line.match(/^(\d{1,2})\s*[:\-\)]\s*([1-5A-E])\b/i);
    if (!m) continue;
    const n = Number(m[1]);
    let v = m[2].toUpperCase();

    // 혹시 A-E로 나오면 1-5로 변환 (성균관대 정답표가 번호라서)
    if (["A", "B", "C", "D", "E"].includes(v)) {
      v = String("ABCDE".indexOf(v) + 1);
    }

    if (targetNumbers.includes(n)) ans.set(n, v);
  }

  // UNSURE 라인 파싱 (있으면)
  const u = String(raw || "").match(/UNSURE\s*:\s*([0-9,\s]+)/i);
  if (u) {
    const list = u[1].split(",").map(s => Number(s.trim())).filter(n => n >= 1 && n <= 50);
    for (const n of list) unsure.add(n);
  }

  // 누락은 무조건 찍고 unsure로
  for (const n of targetNumbers) {
    if (!ans.has(n)) {
      ans.set(n, guessDefaultForNumber(n));
      unsure.add(n);
    }
  }

  return { ans, unsure: Array.from(unsure).sort((a, b) => a - b) };
}

async function callOpenRouter({ model, prompt, stopToken, timeoutMs }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("ServerMisconfig: OPENROUTER_API_KEY missing");

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.0,
        max_tokens: 300,
        stop: stopToken ? [stopToken] : undefined,
        messages: [
          {
            role: "system",
            content:
              "You are a precise multiple-choice answer key generator for Sungkyunkwan University transfer English.\n" +
              "Rules:\n" +
              "- Output MUST include an answer for every requested question number.\n" +
              "- Output format: one per line: \"N: 1-5\" (numbers only).\n" +
              "- If you are not confident, still choose, and list that N in the final UNSURE line.\n" +
              "- Final line: \"UNSURE: ...\" (comma-separated) or \"UNSURE: -\".\n" +
              "- Do not output anything else."
          },
          { role: "user", content: prompt }
        ]
      }),
      signal: ac.signal
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      throw new Error(`HTTP ${resp.status}: OpenRouter error`);
    }
    const text = data.choices?.[0]?.message?.content || "";
    return text;
  } finally {
    clearTimeout(t);
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method Not Allowed" }) };
    }

    const body = JSON.parse(event.body || "{}");
    const page = Number(body.page || 1);
    const rawOcr = body.ocrText || "";

    const ocrText = normalizeOcrMinimal(rawOcr);
    if (!ocrText) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, text: "UNSURE: -\nXURTH", usedNumbers: [], unsure: [] }) };
    }

    const targetNumbers = detectSectionTargetNumbers(ocrText);
    const blocks = buildBlocks(ocrText, targetNumbers);

    // 모델에 너무 긴 본문을 주지 말고, "타겟 블록 위주"로 전달
    const parts = [];
    parts.push(`TARGET QUESTIONS: ${targetNumbers[0]}-${targetNumbers[targetNumbers.length - 1]}`);
    parts.push("");
    for (const n of targetNumbers) {
      const b = blocks.get(n);
      if (b) {
        parts.push(`Q${n}:\n${b}\n`);
      }
    }
    // 블록이 거의 없으면 전체 OCR도 조금 넣어줌
    if (parts.join("\n").length < 800) {
      parts.push("\nFULL OCR (fallback):\n" + ocrText.slice(0, 6000));
    }

    const model = process.env.MODEL_NAME || "openai/gpt-5.1";
    const stopToken = process.env.STOP_TOKEN || "XURTH";

    const prompt = parts.join("\n");

    // OpenRouter 호출 (타임아웃은 짧게, 실패하면 로컬로 전부 찍기)
    let raw;
    try {
      raw = await callOpenRouter({ model, prompt, stopToken, timeoutMs: 20000 });
    } catch (e) {
      raw = ""; // 아래에서 전부 디폴트 찍기
    }

    const { ans, unsure } = parseModelAnswers(raw, targetNumbers);

    // 출력 텍스트 구성
    const lines = [];
    const usedNumbers = [];
    for (const n of targetNumbers) {
      const v = ans.get(n);
      lines.push(`${n}: ${v}`);
      usedNumbers.push(n);
    }
    lines.push(`UNSURE: ${unsure.length ? unsure.join(",") : "-"}`);
    lines.push(stopToken);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        text: lines.join("\n"),
        model,
        usedNumbers,
        unsure
      })
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: "ServerError", detail: e?.message || String(e) })
    };
  }
};

