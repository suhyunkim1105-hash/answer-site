// netlify/functions/parse-questions.js
// OCR 전체 텍스트를 받아서 5지선다 문항 리스트로 변환한다.
// 입력: { text: "..." }
// 출력:
//  - 성공: { ok:true, questions:[{ number, stem, choices:[...5개] }, ...] }
//  - 실패: { ok:false, error:"...", detail?:any }

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const body = safeJson(event.body);
    const text = String(body?.text || "").trim();
    if (!text) {
      return json(400, { ok: false, error: "Missing text" });
    }

    const questions = parseQuestionsFromText(text);

    if (!questions.length) {
      return json(200, { ok: false, error: "No questions parsed" });
    }

    return json(200, { ok: true, questions });
  } catch (e) {
    return json(200, {
      ok: false,
      error: String(e?.message || e || "Unknown parse error"),
    });
  }
}

/**
 * OCR 텍스트 → 문항 배열
 * - 성균관대/홍익대 편입 영어 스타일을 기준으로 설계
 * - 1~50번, 보기 5개 이상인 문항만 남긴다.
 */
function parseQuestionsFromText(raw) {
  // 1. STOP 토큰(XVRTH/XURTH) 이후 텍스트는 버린다.
  let text = String(raw || "");
  const stopIdx = findStopIndex(text);
  if (stopIdx >= 0) {
    text = text.slice(0, stopIdx);
  }

  // 2. 개행/공백 정리
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 3. 라인 단위로 파싱
  const lines = text.split("\n").map((l) => l.trim());

  const qRegex = /^(?:\(|\[)?\s*(0?[1-9]|[1-4]\d|50)[\.\)\]\-]?\s*(.*)$/;
  // 보기 줄: ①~⑤, 1~5, A~E, 특수기호(®, ©, •, @, ^) 등을 모두 허용
  const choiceRegex = /^\s*([①-⑤1-5A-Ea-e•@©®\^])[\).\s]+(.+)$/;

  const questions = [];
  let current = null;

  for (let rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 문항 시작 줄인지 확인
    const qm = line.match(qRegex);
    if (qm) {
      const num = Number(qm[1]);
      const rest = qm[2]?.trim() || "";

      // 기존 문항 있으면 push
      if (current) {
        finalizeQuestion(current, questions);
      }

      current = {
        number: num,
        stem: rest,
        choices: [],
      };
      continue;
    }

    // 보기 줄인지 확인
    if (current) {
      const cm = line.match(choiceRegex);
      if (cm) {
        const choiceText = cm[2]?.trim() || "";
        if (choiceText) {
          current.choices.push(choiceText);
        }
        continue;
      }

      // 보기 줄도, 새 문항도 아니면
      // 아직 보기 수가 0이면 → 지문(stem)의 연속 줄로 본다.
      if (!current.choices.length) {
        current.stem = (current.stem + " " + line).trim();
      } else {
        // 이미 보기들을 모으는 중이면 → 마지막 보기의 이어지는 줄로 취급
        const lastIdx = current.choices.length - 1;
        current.choices[lastIdx] =
          (current.choices[lastIdx] + " " + line).trim();
      }
    }
  }

  // 마지막 문항 처리
  if (current) {
    finalizeQuestion(current, questions);
  }

  // 4. 후처리: 번호 1~50, 보기 5개 이상인 문항만 남기기
  const cleaned = questions
    .filter(
      (q) =>
        Number.isFinite(q.number) &&
        q.number >= 1 &&
        q.number <= 50 &&
        Array.isArray(q.choices) &&
        q.choices.filter((c) => c && c.length > 0).length >= 4 // 최소 4개 이상
    )
    .map((q) => {
      const dedupChoices = q.choices.filter((c) => c && c.length > 0);
      // 보기 최대 5개까지만 사용
      return {
        number: q.number,
        stem: q.stem.trim(),
        choices: dedupChoices.slice(0, 5),
      };
    });

  // 혹시 같은 번호가 여러 번 생겼으면, "보기 수가 많은 것" 우선으로 하나만 남김
  const byNumber = new Map();
  for (const q of cleaned) {
    const prev = byNumber.get(q.number);
    if (!prev || q.choices.length > prev.choices.length) {
      byNumber.set(q.number, q);
    }
  }

  // 번호 기준 정렬
  return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
}

// STOP 토큰(XVRTH/XURTH)이 처음 나타나는 위치를 찾는다.
function findStopIndex(text) {
  if (!text) return -1;
  const upper = String(text).toUpperCase();
  const idx1 = upper.indexOf("XVRTH");
  const idx2 = upper.indexOf("XURTH");
  if (idx1 === -1 && idx2 === -1) return -1;
  if (idx1 === -1) return idx2;
  if (idx2 === -1) return idx1;
  return Math.min(idx1, idx2);
}

// 현재 문항을 questions 배열에 넣기 전에 가볍게 정리
function finalizeQuestion(current, questions) {
  if (!current) return;
  current.stem = (current.stem || "").trim();
  current.choices = Array.isArray(current.choices) ? current.choices : [];
  // stem이 거의 없으면(헤더 줄 같은 것) 버린다.
  if (!current.stem) return;
  questions.push(current);
}

// 공통 JSON 응답 유틸
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
