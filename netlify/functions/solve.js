// netlify/functions/solve.js
// OpenRouter를 호출해 5지선다 정답 번호(1~5)만 JSON으로 반환한다.
//
// 입력(둘 다 지원):
// A) { questions: [{ number, stem, choices:[...] }...] }
// B) { text: "OCR 전체 텍스트" }  <-- 이번 index.html이 사용
//
// 출력:
// { ok:true, answers:{ "1":3, ... }, meta:{...} }
// { ok:false, error:"...", bad_questions:[...], meta:{...} }

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, { ok: false, error: "Missing OPENROUTER_API_KEY env var" });
    }

    const body = safeJson(event.body);

    // 1) questions 우선, 없으면 OCR text 파싱
    let qList = normalizeQuestions(body?.questions);

    if (!qList || qList.length === 0) {
      const rawText = String(body?.text || "").trim();
      if (!rawText) return json(400, { ok: false, error: "Missing questions or text" });
      qList = parseQuestionsFromOcrText(rawText);
    }

    if (!qList || qList.length === 0) {
      return json(200, { ok: false, error: "Question parse failed (need recapture)", bad_questions: [], meta: { parsed: 0 } });
    }

    // 2) 파싱 품질 검사 (너무 약하면 자동 재촬영 유도)
    const bad = qList
      .filter(q => q.stem.length < 10 || q.choices.filter(x => x.length > 0).length < 5)
      .map(q => q.number);

    if (bad.length > 0) {
      return json(200, {
        ok: false,
        error: "Question parse too weak (need recapture)",
        bad_questions: bad.slice(0, 25),
        meta: { parsed: qList.length }
      });
    }

    // 3) 타임아웃 방지: 10문항씩 끊어서 풀이
    const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
    const fallbackModel = process.env.OPENROUTER_MODEL_FALLBACK || ""; // 옵션
    const timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS || 18000);

    qList.sort((a, b) => a.number - b.number);
    const chunks = chunkBy(qList, 10);

    const merged = {};
    const rawSnippets = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const prompt = buildPrompt(chunk);

      const res1 = await callOpenRouter({ apiKey, model, timeoutMs, prompt });
      rawSnippets.push(res1.raw.slice(0, 800));

      let parsed = parseAnswers(res1.raw);

      // 1회 재시도(같은 모델)
      if (!parsed) {
        const res2 = await callOpenRouter({
          apiKey,
          model,
          timeoutMs,
          prompt: prompt + "\n\n다시 말한다. JSON 이외의 글자 1개라도 출력하면 실패다. 반드시 JSON만 출력하라."
        });
        rawSnippets.push(res2.raw.slice(0, 800));
        parsed = parseAnswers(res2.raw);
      }

      // (옵션) fallback 모델 1회
      if (!parsed && fallbackModel) {
        const res3 = await callOpenRouter({ apiKey, model: fallbackModel, timeoutMs, prompt });
        rawSnippets.push(res3.raw.slice(0, 800));
        parsed = parseAnswers(res3.raw);
      }

      if (!parsed) {
        return json(200, {
          ok: false,
          error: "Failed to parse answers",
          raw: rawSnippets.join("\n---\n").slice(0, 2000),
          meta: { chunk: i + 1, chunks: chunks.length }
        });
      }

      Object.assign(merged, parsed);
    }

    // 4) 누락 검사
    const expected = new Set(qList.map(q => String(q.number)));
    const got = new Set(Object.keys(merged));
    const missing = [];
    for (const k of expected) if (!got.has(k)) missing.push(Number(k));

    if (missing.length > 0) {
      return json(200, {
        ok: false,
        error: "Some answers missing (need recapture or retry)",
        bad_questions: missing.slice(0, 25),
        partial: merged,
        meta: { parsed: qList.length, answered: Object.keys(merged).length }
      });
    }

    return json(200, {
      ok: true,
      answers: merged,
      meta: { parsed: qList.length, answered: Object.keys(merged).length, chunks: chunks.length },
      raw: rawSnippets.join("\n---\n").slice(0, 4000)
    });

  } catch (e) {
    const msg = String(e?.name === "AbortError" ? "OpenRouter timeout" : (e?.message || e));
    return json(200, { ok: false, error: msg });
  }
}

/* -------------------- OpenRouter call -------------------- */

async function callOpenRouter({ apiKey, model, timeoutMs, prompt }) {
  const payload = {
    model,
    temperature: 0,
    max_tokens: 450,
    messages: [
      {
        role: "system",
        content:
          "You are a careful exam solver. Output MUST be valid JSON only, nothing else. " +
          'Return only: {"answers":{"1":3,"2":5,...}} with all questions included.'
      },
      { role: "user", content: prompt }
    ]
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: controller.signal,
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  }).catch((e) => ({ ok: false, _fetchError: e }));

  clearTimeout(t);

  if (resp && resp.ok === false && resp._fetchError) {
    throw new Error("OpenRouter fetch failed: " + String(resp._fetchError?.message || resp._fetchError));
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error("OpenRouter upstream error: " + JSON.stringify(data).slice(0, 1200));
  }

  const raw = String(data?.choices?.[0]?.message?.content ?? "");
  return { raw };
}

/* -------------------- parsing -------------------- */

function normalizeQuestions(questions) {
  if (!Array.isArray(questions)) return null;
  const qList = questions
    .map(q => ({
      number: Number(q?.number),
      stem: String(q?.stem || "").trim(),
      choices: Array.isArray(q?.choices) ? q.choices.map(c => String(c || "").trim()) : []
    }))
    .filter(q => Number.isFinite(q.number) && q.number >= 1 && q.number <= 50);
  return qList.length ? qList : null;
}

function parseQuestionsFromOcrText(fullText) {
  const t = String(fullText || "").replace(/\r/g, "\n");

  // 문항 시작점: 줄 시작의 01~50
  const re = /(?:^|\n)\s*(0[1-9]|[1-4][0-9]|50)\b/g;
  const hits = [];
  let m;
  while ((m = re.exec(t)) !== null) hits.push({ q: parseInt(m[1], 10), idx: m.index });
  hits.sort((a, b) => a.idx - b.idx);

  const blocks = new Map();
  for (let i = 0; i < hits.length; i++) {
    const q = hits[i].q;
    const start = hits[i].idx;
    const end = (i + 1 < hits.length) ? hits[i + 1].idx : t.length;
    const block = t.slice(start, end).trim();
    if (!blocks.has(q) || block.length > blocks.get(q).length) blocks.set(q, block);
  }

  const out = [];
  for (let q = 1; q <= 50; q++) {
    if (!blocks.has(q)) continue;
    const parsed = parseOneQuestionBlock(q, blocks.get(q));
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseOneQuestionBlock(number, block) {
  const s = String(block || "").replace(/\r/g, "\n");

  // 선택지 마커 후보: "1)" / "2)" / A) / 특수기호(•®@©*^ 등)
  const markerRe = /(?:^|\n)\s*(?:[1-5][\)\.\]]|[A-E][\)\.\]]|[•@©®\*\^])\s+/gm;
  const marks = [];
  let m;
  while ((m = markerRe.exec(s)) !== null) marks.push({ idx: m.index, len: m[0].length });

  let stem = "";
  let choices = [];

  if (marks.length >= 5) {
    stem = s.slice(0, marks[0].idx).replace(/^\s*(0[1-9]|[1-4][0-9]|50)\b/, "").trim();
    for (let i = 0; i < 5; i++) {
      const start = marks[i].idx + marks[i].len;
      const end = (i + 1 < marks.length) ? marks[i + 1].idx : s.length;
      choices.push(s.slice(start, end).trim());
    }
  } else {
    // 라인 기반 보정
    const lines = s.split("\n").map(x => x.trim()).filter(Boolean);
    const choiceLines = lines.filter(isChoiceLine);
    if (choiceLines.length >= 5) {
      const firstChoice = choiceLines[0];
      const idx = lines.indexOf(firstChoice);
      const stemLines = lines.slice(0, Math.max(1, idx));
      stem = stemLines.join(" ").replace(/^\s*(0[1-9]|[1-4][0-9]|50)\b/, "").trim();
      choices = choiceLines.slice(0, 5).map(stripChoiceMarker);
    }
  }

  stem = oneLine(stem);
  choices = choices.map(oneLine);

  if (stem.length < 10) return null;
  if (choices.length < 5) return null;
  if (choices.filter(x => x.length > 0).length < 5) return null;

  return { number, stem, choices };
}

function isChoiceLine(line) {
  return /^\s*([1-5][\)\.\]]|[A-E][\)\.\]]|[•@©®\*\^])\s+/.test(line);
}

function stripChoiceMarker(line) {
  return line.replace(/^\s*([1-5][\)\.\]]|[A-E][\)\.\]]|[•@©®\*\^])\s+/, "").trim();
}

function buildPrompt(qList) {
  let s = "";
  s += "다음은 편입영어 5지선다 객관식 문제이다. 각 문항의 정답 번호(1~5)만 JSON으로 출력하라.\n";
  s += "규칙:\n";
  s += "1) 출력은 오직 JSON 한 덩어리만. 다른 텍스트 금지.\n";
  s += '2) 형식: {"answers":{"1":3,"2":5,...}} (키는 문항번호, 값은 정답 번호 1~5)\n';
  s += "3) 문항 수만큼 키를 모두 포함하라.\n\n";

  for (const q of qList) {
    s += `문항 ${q.number}\n`;
    s += `${q.stem}\n`;
    for (let i = 0; i < 5; i++) s += `${i + 1}) ${q.choices[i]}\n`;
    s += "\n";
  }
  s += "JSON만 출력하라.\n";
  return s;
}

function parseAnswers(text) {
  const t = String(text || "").trim();

  const firstBrace = t.indexOf("{");
  const lastBrace = t.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const jsonStr = t.slice(firstBrace, lastBrace + 1);
    try {
      const obj = JSON.parse(jsonStr);
      const ans = obj?.answers;
      if (ans && typeof ans === "object") {
        const out = {};
        for (const [k, v] of Object.entries(ans)) {
          const q = parseInt(k, 10);
          const c = parseInt(v, 10);
          if (Number.isFinite(q) && Number.isFinite(c) && c >= 1 && c <= 5) out[String(q)] = c;
        }
        if (Object.keys(out).length > 0) return out;
      }
    } catch (_) {}
  }

  // fallback: "1:3"
  const out = {};
  const re = /\b(0?[1-9]|[1-4][0-9]|50)\s*[:=]\s*([1-5])\b/g;
  let m;
  while ((m = re.exec(t)) !== null) out[String(parseInt(m[1], 10))] = parseInt(m[2], 10);
  return Object.keys(out).length ? out : null;
}

function chunkBy(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(obj),
  };
}

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch (_) { return {}; }
}

