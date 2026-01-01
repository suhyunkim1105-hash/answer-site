// netlify/functions/parse-questions.js
// OCR 전체 텍스트 → { number, stem, choices[5] } 배열로 변환
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }
    const body = safeJson(event.body);
    const raw =
      (body && typeof body.ocrText === "string" && body.ocrText) ||
      (body && typeof body.text === "string" && body.text) ||
      "";
    const text = String(raw).trim();
    if (!text) {
      return json(200, { ok: false, error: "Missing ocrText" });
    }

    const questions = parseQuestions(text);
    if (!questions.length) {
      return json(200, {
        ok: false,
        error: "No questions parsed",
        debug: { length: text.length }
      });
    }

    return json(200, {
      ok: true,
      count: questions.length,
      questions
    });
  } catch (e) {
    return json(200, {
      ok: false,
      error: e && e.message ? e.message : String(e)
    });
  }
}

function normalize(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\u00b7/g, "·");
}

function parseQuestions(raw) {
  const text = normalize(raw);
  const lines = text
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const questions = [];
  let cur = null;

  const numRe = /^(\d{1,2})\s+(.*)$/;
  const choiceRe = /^((?:[•·\-\u2022\u00b7①②③④⑤@©®\*])|(?:[1-5]\)))[\s\.]*(.+)$/;

  for (const line of lines) {
    if (/X[UV]RTH/i.test(line)) {
      // 마지막 페이지 STOP 토큰은 버린다.
      continue;
    }

    let m = line.match(numRe);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num >= 1 && num <= 50) {
        if (cur) questions.push(finalize(cur));
        cur = { number: num, stem: (m[2] || "").trim(), choices: [] };
        continue;
      }
    }

    if (!cur) continue;

    m = line.match(choiceRe);
    if (m) {
      const choiceText = (m[2] || "").trim();
      if (!choiceText) continue;
      if (cur.choices.length < 5) {
        cur.choices.push(choiceText);
      } else {
        // 5개를 이미 넘으면 마지막 선택지에 이어 붙인다.
        const last = cur.choices.length - 1;
        cur.choices[last] = (cur.choices[last] + " " + choiceText).trim();
      }
      continue;
    }

    // 보기도, 번호도 아닌 줄: 질문 본문이나 보기의 다음 줄
    if (cur.choices.length === 0) {
      cur.stem = (cur.stem + " " + line).trim();
    } else {
      const last = cur.choices.length - 1;
      cur.choices[last] = (cur.choices[last] + " " + line).trim();
    }
  }

  if (cur) questions.push(finalize(cur));

  // 보기 5개가 있는 문항만 사용
  return questions
    .filter(q => q.choices && q.choices.length === 5)
    .map(finalize);
}

function finalize(q) {
  return {
    number: q.number,
    stem: String(q.stem || "").replace(/\s+/g, " ").trim(),
    choices: (q.choices || []).map(c =>
      String(c || "")
        .replace(/\s+/g, " ")
        .trim()
    )
  };
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(obj)
  };
}

function safeJson(str) {
  try {
    return JSON.parse(str || "{}");
  } catch (_) {
    return {};
  }
}
