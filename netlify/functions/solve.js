// netlify/functions/solve.js
// 입력:
// 1) { ocr_text: "..." }  // 권장(프론트가 OCR 통째로 전달)
// 또는
// 2) { questions: [{ number, stem, choices:[...] }...] } // 구버전 호환
//
// 출력: { ok:true, answers:{ "1":3, ... } } or { ok:false, error, bad_questions? }

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

    // 1) ocr_text 우선
    let qList = [];
    if (typeof body?.ocr_text === "string" && body.ocr_text.trim().length > 0) {
      qList = parseFromOcrText(body.ocr_text);
    } else if (Array.isArray(body?.questions)) {
      qList = normalizeQuestions(body.questions);
    } else {
      return json(400, { ok: false, error: "Missing ocr_text or questions" });
    }

    if (!qList || qList.length === 0) {
      return json(200, { ok: false, error: "No valid questions parsed", bad_questions: [] });
    }

    // 파싱 품질 체크
    const bad = qList
      .filter(q => q.stem.length < 20 || q.choices.filter(x => x.length > 0).length < 5)
      .map(q => q.number);

    // 자동화용: bad가 많으면 바로 재촬영 유도
    // (너무 엄격하면 못 푼다 -> 8개 이상이면 리턴)
    if (bad.length >= 8) {
      return json(200, {
        ok: false,
        error: "Question parse too weak (need recapture)",
        bad_questions: bad.slice(0, 20),
        parsed_count: qList.length
      });
    }

    // ===== OpenRouter 호출 (배치) =====
    const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
    const timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS || 18000);
    const batchSize = Number(process.env.BATCH_SIZE || 6); // 타임아웃 줄이기 위해 5~8 권장

    const batches = chunk(qList, batchSize);

    const finalAnswers = {};
    const raws = [];

    for (let i = 0; i < batches.length; i++) {
      const prompt = buildPrompt(batches[i]);

      const payload = {
        model,
        temperature: 0,
        messages: [
          { role: "system", content: "You are a careful multiple-choice exam solver. Output must be valid JSON only." },
          { role: "user", content: prompt }
        ],
      };

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);

      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      }).catch((e) => ({ ok: false, _fetchError: e }));

      clearTimeout(t);

      if (resp && resp.ok === false && resp._fetchError) {
        return json(200, { ok: false, error: "OpenRouter fetch failed", detail: String(resp._fetchError?.message || resp._fetchError) });
      }

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return json(502, { ok: false, error: "OpenRouter upstream error", detail: data });
      }

      const text = data?.choices?.[0]?.message?.content ?? "";
      raws.push(String(text).slice(0, 1500));

      const parsed = parseAnswers(text);
      if (!parsed) {
        return json(200, { ok: false, error: "Failed to parse answers", raw: String(text).slice(0, 4000) });
      }

      // merge
      for (const [k, v] of Object.entries(parsed)) {
        finalAnswers[k] = v;
      }
    }

    // 혹시 누락된 번호가 있으면 bad로 리턴
    const missing = qList.map(q => String(q.number)).filter(k => !(k in finalAnswers));
    if (missing.length > 0) {
      return json(200, {
        ok: false,
        error: "Some answers missing (need recapture or model issue)",
        bad_questions: missing.slice(0, 20),
        answers: finalAnswers,
        raw: raws.join("\n---\n")
      });
    }

    return json(200, { ok: true, answers: finalAnswers, raw: raws.join("\n---\n") });

  } catch (e) {
    const msg = String(e?.name === "AbortError" ? "OpenRouter timeout" : (e?.message || e));
    return json(200, { ok: false, error: msg });
  }
}

// ===== Parsing helpers =====

function normalizeQuestions(questions) {
  const qList = questions
    .map(q => ({
      number: Number(q?.number),
      stem: String(q?.stem || "").trim(),
      choices: Array.isArray(q?.choices) ? q.choices.map(c => String(c || "").trim()) : []
    }))
    .filter(q => Number.isFinite(q.number) && q.number >= 1 && q.number <= 50);

  // ensure 5 choices
  for (const q of qList) {
    while (q.choices.length < 5) q.choices.push("");
    q.choices = q.choices.slice(0, 5);
  }
  return qList;
}

function parseFromOcrText(ocrText) {
  const text = String(ocrText || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  // 섹션 헤더([01-05] 같은 것) 제거(문항 시작 탐지 방해)
  const cleaned = text.replace(/\[\s*\d{1,2}\s*-\s*\d{1,2}\s*\][^\n]*\n?/g, "\n");

  const lines = cleaned.split("\n").map(x => x.trim()).filter(x => x.length > 0);

  // 문항 시작 후보: "01", "1", "11" 등이 라인 맨 앞에 오는 패턴
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([0-9]{1,2})\b(.*)$/);
    if (!m) continue;

    const n = parseInt(m[1], 10);
    if (!(n >= 1 && n <= 50)) continue;

    // "2022학년도" 같은 제목 숫자 오탐 방지: 뒤 텍스트가 너무 짧고 '학년도' 포함 등은 제외
    const tail = (m[2] || "").trim();
    if (/학년도|성균관대|편입학|문제지/i.test(tail)) continue;

    // 아주 짧은 라인(예: 페이지 번호) 제외
    if (tail.length < 2) continue;

    starts.push({ idx: i, num: n });
  }

  // 중복 제거(같은 번호가 여러 번 잡히면 첫 등장만)
  const seen = new Set();
  const uniq = [];
  for (const s of starts) {
    if (seen.has(s.num)) continue;
    seen.add(s.num);
    uniq.push(s);
  }
  uniq.sort((a,b) => a.idx - b.idx);

  const out = [];

  for (let k = 0; k < uniq.length; k++) {
    const cur = uniq[k];
    const next = uniq[k+1];
    const blockLines = lines.slice(cur.idx, next ? next.idx : lines.length);

    const q = parseQuestionBlock(cur.num, blockLines);
    if (q) out.push(q);
  }

  // 1~50 범위만
  return out.filter(q => q.number >= 1 && q.number <= 50);
}

function parseQuestionBlock(num, blockLines) {
  // 첫 라인에서 번호 제거
  const first = blockLines[0].replace(/^[0-9]{1,2}\b[).:]?\s*/, "").trim();
  const rest = blockLines.slice(1);

  // 옵션 후보 수집: 아래에서 위로 5개 잡는 방식(2단 OCR 깨짐에 상대적으로 강함)
  const candidates = [];
  for (let i = blockLines.length - 1; i >= 0; i--) {
    const raw = blockLines[i].trim();
    if (!raw) continue;

    // 옵션 라인 휴리스틱:
    // - 길이 너무 길면 옵션일 확률 낮음
    // - "Choose" "According" 같은 본문 문장 시작은 제외
    if (raw.length > 90) continue;
    if (/^(choose|according|everyone|when|with|some|the|in)\b/i.test(raw)) continue;

    // bullet/특수기호/숫자) 시작이면 옵션 가능성 ↑
    if (/^[@•®©\*\^]|^[1-5]\)/.test(raw) || /^[A-E]\b[).]/i.test(raw)) {
      candidates.push(raw);
      if (candidates.length >= 5) break;
      continue;
    }

    // 짧은 구/단어 + 알파벳 비율 높으면 옵션 후보로 추가
    if (/[A-Za-z]/.test(raw) && raw.split(/\s+/).length <= 6) {
      candidates.push(raw);
      if (candidates.length >= 5) break;
    }
  }

  const options = candidates.reverse().map(stripOptionPrefix);

  if (options.length < 5) {
    // 옵션이 5개 미만이면 약하게라도 stem만 구성(프론트가 재촬영 유도 가능)
    return {
      number: num,
      stem: (first + " " + rest.join(" ")).trim().slice(0, 2000),
      choices: options.concat(Array(Math.max(0, 5 - options.length)).fill(""))
    };
  }

  // 옵션이 시작되는 라인 위치 찾기(블록에서 options[0]이 있던 지점)
  // 정확히 찾기 어려워서 stem은 “옵션 후보 5개를 제외한 위쪽”을 대충 합친다.
  const optSet = new Set(candidates.map(x => x.trim()));
  const stemLines = [];
  // 번호 제거된 첫 줄 + 나머지 중, options 후보로 잡힌 라인 제외
  stemLines.push(first);
  for (const l of rest) {
    if (optSet.has(l.trim())) continue;
    stemLines.push(l);
  }

  const stem = stemLines.join(" ").replace(/\s{2,}/g, " ").trim().slice(0, 2000);

  return { number: num, stem, choices: options.slice(0,5) };
}

function stripOptionPrefix(s) {
  let t = String(s || "").trim();
  t = t.replace(/^[@•®©\*\^\-]+/, "").trim();
  t = t.replace(/^[1-5]\)\s*/, "").trim();
  t = t.replace(/^[A-E][).]\s*/i, "").trim();
  return t;
}

// ===== Prompt / Parse =====

function buildPrompt(qList) {
  let s = "";
  s += "다음은 편입영어 5지선다 객관식 문제이다. 각 문항의 정답 번호(1~5)만 JSON으로 출력하라.\n";
  s += "규칙:\n";
  s += "1) 출력은 오직 JSON 한 덩어리만. 다른 텍스트 금지.\n";
  s += '2) 형식: {"answers":{"1":3,"2":5,...}} (키=문항번호, 값=정답 번호 1~5)\n';
  s += "3) 문항 수만큼 키를 모두 포함하라.\n\n";

  for (const q of qList) {
    s += `문항 ${q.number}\n`;
    s += `${q.stem}\n`;
    for (let i = 0; i < 5; i++) {
      s += `${i+1}) ${q.choices[i]}\n`;
    }
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
        for (const [k,v] of Object.entries(ans)) {
          const q = parseInt(k, 10);
          const c = parseInt(v, 10);
          if (Number.isFinite(q) && Number.isFinite(c) && c >= 1 && c <= 5) out[String(q)] = c;
        }
        if (Object.keys(out).length > 0) return out;
      }
    } catch (_) {}
  }

  // fallback "1:3" style
  const out = {};
  const re = /\b(0?[1-9]|[1-4][0-9]|50)\s*[:=]\s*([1-5])\b/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    out[String(parseInt(m[1], 10))] = parseInt(m[2], 10);
  }
  if (Object.keys(out).length > 0) return out;

  return null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(obj),
  };
}

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch (_) { return {}; }
}
