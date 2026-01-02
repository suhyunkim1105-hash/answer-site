// netlify/functions/solve.js
// 입력: { page, ocrText }
// 출력: { ok, text, usedNumbers, unsure, model }

const fetch = globalThis.fetch;

function normalize(s) {
  if (!s) return "";
  return String(s)
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐-‒–—]/g, "-")
    .replace(/[①]/g, "1").replace(/[②]/g, "2").replace(/[③]/g, "3").replace(/[④]/g, "4").replace(/[⑤]/g, "5")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findQuestionMarkers(text) {
  const t = "\n" + text;
  // 줄 시작에 가까운 번호 패턴들만 잡음 (연도/숫자 노이즈 최소화)
  const re = /(?:\n)\s*(\d{1,2})\s*(?:[.\)]\s*(?:\1\s*[.\)])?)?/g;

  let m;
  const hits = [];
  const seen = new Set();
  while ((m = re.exec(t))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 50 && !seen.has(n)) {
      seen.add(n);
      // index는 원문 기준으로 맞추기 위해 -1 (앞에 붙인 \n 보정)
      hits.push({ n, idx: Math.max(0, m.index - 1) });
    }
  }
  hits.sort((a,b) => a.idx - b.idx);
  return hits;
}

function extractBlocks(text, maxChars = 9000) {
  const markers = findQuestionMarkers(text);
  if (markers.length === 0) {
    // 문항 번호를 못 잡으면 텍스트 일부만 잘라서라도 보냄
    return { usedNumbers: [], blocksText: text.slice(0, maxChars) };
  }

  const blocks = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].idx;
    const end = (i + 1 < markers.length) ? markers[i+1].idx : text.length;
    const chunk = text.slice(start, end).trim();
    // 너무 짧은/의미없는 조각 제거
    if (chunk.length >= 30) blocks.push({ n: markers[i].n, chunk });
  }

  // 너무 길면 앞에서부터 누적해서 maxChars까지만
  let out = "";
  const usedNumbers = [];
  for (const b of blocks) {
    const add = `\n\n[Q${b.n}]\n${b.chunk}`;
    if ((out.length + add.length) > maxChars) break;
    out += add;
    usedNumbers.push(b.n);
  }

  return { usedNumbers, blocksText: out.trim() };
}

function mapChoiceToNumber(v) {
  const s = String(v).trim().toUpperCase();
  if (/^[1-5]$/.test(s)) return Number(s);
  if (/^[A-E]$/.test(s)) return "ABCDE".indexOf(s) + 1;
  return null;
}

function formatAnswers(answerMap, unsureList, stopToken) {
  const nums = Object.keys(answerMap).map(Number).sort((a,b)=>a-b);
  const lines = nums.map(n => `${n}: ${answerMap[n]}`);
  const unsure = unsureList.length ? `UNSURE: ${unsureList.sort((a,b)=>a-b).join(",")}` : `UNSURE: -`;
  return `${lines.join("\n")}\n${unsure}\n${stopToken}`;
}

async function callOpenRouter({ model, apiKey, stopToken, promptText, timeoutMs }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        top_p: 1,
        max_tokens: 220,             // 정답만: 아주 작게
        stop: [stopToken],
        messages: [
          {
            role: "system",
            content:
              "You are an exam answer-key generator. " +
              "Always output an answer for every question number provided, never leave blank. " +
              "If uncertain, still guess but list those numbers in UNSURE at the end."
          },
          {
            role: "user",
            content:
              "Return ONLY numeric choices 1-5.\n" +
              "If options are A-E, map A=1,B=2,C=3,D=4,E=5.\n\n" +
              "Answer all questions contained in the OCR blocks below.\n" +
              "Output format:\n" +
              "13: 2\n" +
              "14: 4\n" +
              "...\n" +
              "UNSURE: 13,18\n" +
              stopToken + "\n\n" +
              "OCR BLOCKS:\n" + promptText
          }
        ]
      }),
      signal: ac.signal
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`;
      throw new Error(msg);
    }

    const text = data.choices?.[0]?.message?.content || "";
    return text;
  } finally {
    clearTimeout(t);
  }
}

function parseModelOutput(text) {
  const out = String(text || "");
  const lines = out.split(/\n+/).map(s => s.trim()).filter(Boolean);

  const answers = {};
  const unsure = new Set();

  for (const line of lines) {
    // "13: 2" or "13 - B"
    const m = line.match(/^(\d{1,2})\s*[:\-]\s*([1-5A-E])\b/i);
    if (m) {
      const q = Number(m[1]);
      const v = mapChoiceToNumber(m[2]);
      if (q >= 1 && q <= 50 && v) answers[q] = v;
      continue;
    }
    const u = line.match(/^UNSURE\s*:\s*(.*)$/i);
    if (u) {
      const nums = (u[1] || "").split(/[, ]+/).map(x => Number(x)).filter(n => n>=1 && n<=50);
      nums.forEach(n => unsure.add(n));
    }
  }

  return { answers, unsure: Array.from(unsure) };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method Not Allowed" }) };
    }

    const body = JSON.parse(event.body || "{}");
    const raw = body.ocrText || "";
    const stopToken = process.env.STOP_TOKEN || "XURTH";

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: "ServerMisconfig: missing OpenRouter key" }) };
    }

    const modelPrimary = process.env.MODEL_NAME || "openai/gpt-5.1";
    const modelFallback = process.env.FALLBACK_MODEL || "openai/gpt-4.1-mini"; // 빠른 탈출용

    const text = normalize(raw);

    // 1) 문항 블록만 추출해서 토큰/시간 줄이기
    const { usedNumbers, blocksText } = extractBlocks(text, 9000);

    // 2) 질문 번호를 못 잡아도 일단 진행 (무조건 답 출력)
    const targetNumbers = (usedNumbers.length ? usedNumbers : findQuestionMarkers(text).map(x => x.n));
    const uniqueTargets = Array.from(new Set(targetNumbers)).filter(n => n>=1 && n<=50).sort((a,b)=>a-b);

    // 타겟이 0이면: 어쩔 수 없이 1~20 같은 범위도 못 정함 -> 빈 배열로 둠
    // 대신 모델에 전체 블록 보내고, 파싱 안 되면 휴리스틱 채움
    const promptText = blocksText || text.slice(0, 9000);

    let modelUsed = modelPrimary;
    let modelText = "";
    let parsed = null;

    // 3) 1차 모델(짧은 타임아웃). 실패하면 fallback
    try {
      modelText = await callOpenRouter({
        model: modelPrimary,
        apiKey,
        stopToken,
        promptText,
        timeoutMs: 17000
      });
      parsed = parseModelOutput(modelText);
    } catch (e1) {
      try {
        modelUsed = modelFallback;
        modelText = await callOpenRouter({
          model: modelFallback,
          apiKey,
          stopToken,
          promptText,
          timeoutMs: 12000
        });
        parsed = parseModelOutput(modelText);
      } catch (e2) {
        parsed = { answers: {}, unsure: [] };
      }
    }

    // 4) “항상 답 출력” 보장: 빠진 문항은 3(C)로 채우고 UNSURE에 넣음
    const answerMap = {};
    const unsureSet = new Set(parsed.unsure || []);

    // 타겟 번호가 없으면: 모델이 준 것만이라도 내보내되, 최소한 1~20은 채워주는 게 낫다
    const finalTargets = uniqueTargets.length ? uniqueTargets : Object.keys(parsed.answers).map(Number);

    // 그래도 아무것도 없으면: 1~20 채움(최소 안전망)
    const safeTargets = finalTargets.length ? finalTargets : Array.from({ length: 20 }, (_,i)=>i+1);

    for (const q of safeTargets) {
      const v = parsed.answers[q];
      if (v && v>=1 && v<=5) {
        answerMap[q] = v;
      } else {
        answerMap[q] = 3;
        unsureSet.add(q);
      }
    }

    const outText = formatAnswers(answerMap, Array.from(unsureSet), stopToken);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        text: outText,
        model: modelUsed,
        usedNumbers: safeTargets,
        unsure: Array.from(unsureSet).sort((a,b)=>a-b)
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "ServerError", detail: e?.message || String(e) }) };
  }
};
