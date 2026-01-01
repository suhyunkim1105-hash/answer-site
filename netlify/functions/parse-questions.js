// netlify/functions/parse-questions.js
// OCR로 인식한 전체 텍스트를 5지선다 객관식 문항 배열로 변환한다.
// 입력: { text: "..." }
// 출력: { ok:true, questions:[{ number, stem, choices:[...] }, ...] }

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const body = safeJson(event.body);
    const raw = String(body?.text || "").trim();
    if (!raw) {
      return json(400, { ok: false, error: "Missing text" });
    }

    const text = normalize(raw);
    const questions = parseQuestions(text);

    if (!questions.length) {
      return json(200, {
        ok: false,
        error: "No questions parsed",
        sample: text.slice(0, 1000),
      });
    }

    return json(200, { ok: true, questions });
  } catch (e) {
    return json(200, { ok: false, error: String(e?.message || e) });
  }
}

function normalize(t) {
  // [PAGE 1] 같은 태그 제거
  t = t.replace(/\[PAGE\s+\d+\]/gi, " ");
  // 이상한 공백 줄이기
  t = t.replace(/\r/g, "\n");
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n{2,}/g, "\n");
  return t;
}

// 성균관대/홍익대 스타일 기준 파서
function parseQuestions(text) {
  const qs = [];

  // 문항 블록 추출: 라인 시작이 숫자(1~50)인 것만
  const re = /(^|\n)([0-4]?\d|50)\s+([^\n]+(?:\n(?!\d+\s)[^\n]+)*)/g;
  let m;

  while ((m = re.exec(text)) !== null) {
    const num = parseInt(m[2], 10);
    if (!Number.isFinite(num) || num < 1 || num > 50) continue;

    let block = m[3].trim();
    if (!block) continue;

    // 줄바꿈을 하나의 문장으로 합치기
    block = block.replace(/\n+/g, " ").replace(/[ ]{2,}/g, " ").trim();

    const { stem, choices } = splitStemAndChoices(block);

    if (!stem || choices.length < 5) {
      // 너무 이상하면 스킵
      continue;
    }

    qs.push({
      number: num,
      stem,
      choices: choices.slice(0, 5),
    });
  }

  // 번호 순으로 정렬
  qs.sort((a, b) => a.number - b.number);
  return qs;
}

function splitStemAndChoices(block) {
  // 선택지 구분용 특수문자들 (성대/홍대 OCR에 자주 나오는 기호들)
  const delimRe = /[①②③④⑤⑴⑵⑶⑷⑸@•●▪■♦◆©®\^]/;

  const firstIdx = block.search(delimRe);
  let stem;
  let rest;

  if (firstIdx === -1) {
    // 선택지 구분 기호를 못 찾으면 그냥 전부 지문으로 처리
    stem = block.trim();
    rest = "";
  } else {
    stem = block.slice(0, firstIdx).trim();
    rest = block.slice(firstIdx).trim();
  }

  const rawChoices = rest
    ? rest
        .split(delimRe)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  // 그래도 5개 안 되면, 문장 끝의 마침표 기준으로 한 번 더 잘라보기(보정용)
  let choices = rawChoices;
  if (choices.length < 5 && rest) {
    const tmp = rest
      .replace(delimRe, " ")
      .split(/\s{2,}|\s\.\s/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (tmp.length >= 5) {
      choices = tmp.slice(-5);
    }
  }

  // 너무 짧은 선택지는 버리기
  choices = choices.map((c) => c.replace(/\s+/g, " ").trim());

  return { stem, choices };
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s || "{}");
  } catch (_) {
    return {};
  }
}
