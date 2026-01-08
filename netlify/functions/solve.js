// netlify/functions/solve.js
// 편입 영어 객관식 기출 자동 채점 + 2패스(UNSURE 문항 자동 재풀이)

// 공통 JSON 응답 헬퍼
function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

// OpenRouter 호출 헬퍼
async function callOpenRouter({ apiKey, model, temperature, stopToken, messages, maxTokens }) {
  const endpoint = "https://openrouter.ai/api/v1/chat/completions";

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
      "X-Title": "answer-site-solve",
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      stop: stopToken ? [stopToken] : undefined,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter HTTP ${res.status}: ${text || "unknown error"}`);
  }

  const data = await res.json();
  const choice = data.choices && data.choices[0];
  const content =
    choice &&
    choice.message &&
    typeof choice.message.content === "string"
      ? choice.message.content
      : Array.isArray(choice.message?.content)
      ? choice.message.content.map((c) => c.text || c).join("")
      : "";

  const finishReason = choice && (choice.finish_reason || choice.native_finish_reason) || null;

  return { raw: data, text: content || "", finishReason };
}

// 1차/2차 공통: 모델 출력 파싱
function parseAnswerText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const answers = {};
  const questionNumbers = [];
  const unsureNumbers = [];
  let unsureRaw = null;

  for (const line of lines) {
    // UN SURE: ...
    const mUnsure = line.match(/^UNSURE\s*:\s*(.*)$/i);
    if (mUnsure) {
      unsureRaw = mUnsure[1].trim();
      if (unsureRaw && unsureRaw !== "-" && unsureRaw !== "–") {
        const nums = unsureRaw
          .split(/[,\s/]+/)
          .map((s) => parseInt(s.replace(/[^\d]/g, ""), 10))
          .filter((n) => Number.isFinite(n));
        for (const n of nums) {
          if (!unsureNumbers.includes(n)) unsureNumbers.push(n);
        }
      }
      continue;
    }

    // "12: A" / "12-A" / "12 : 3?" 등
    const m = line.match(/^(\d{1,3})\s*[:\-]\s*([A-D1-4])\??/i);
    if (m) {
      const qNum = parseInt(m[1], 10);
      let opt = m[2].toUpperCase();
      let idx = null;
      if (/[1-4]/.test(opt)) {
        idx = parseInt(opt, 10);
      } else {
        const map = { A: 1, B: 2, C: 3, D: 4 };
        idx = map[opt] || null;
      }
      if (idx && qNum > 0) {
        answers[qNum] = idx;
        if (!questionNumbers.includes(qNum)) questionNumbers.push(qNum);
      }
    }
  }

  questionNumbers.sort((a, b) => a - b);
  unsureNumbers.sort((a, b) => a - b);

  return {
    answers,
    questionNumbers,
    unsureNumbers,
    lines,
    unsureRaw: unsureRaw || (unsureNumbers.length ? unsureNumbers.join(", ") : "-"),
  };
}

// OCR 텍스트에서 각 문항별 스니펫 추출 (2차용)
function extractQuestionSnippets(ocrText, targetNumbers) {
  const targets = new Set(targetNumbers);
  const result = {};
  const lines = String(ocrText || "").split(/\r?\n/);

  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // "16." / "16:" / "16 )" / "16  " 등
    const m = line.match(/^\s*(\d{1,3})[).:\s]/);
    if (m) {
      const q = parseInt(m[1], 10);
      if (Number.isFinite(q)) {
        markers.push({ q, index: i });
      }
    }
  }

  markers.sort((a, b) => a.index - b.index);

  for (let i = 0; i < markers.length; i++) {
    const { q, index } = markers[i];
    if (!targets.has(q)) continue;
    const endIndex = i + 1 < markers.length ? markers[i + 1].index : lines.length;
    const snippet = lines.slice(index, endIndex).join("\n").trim();
    if (snippet) {
      result[q] = snippet;
    }
  }

  // 혹시 못 찾은 번호는 전체 텍스트로라도 채운다.
  for (const q of targetNumbers) {
    if (!result[q]) {
      result[q] = String(ocrText || "");
    }
  }

  return result;
}

// 기존 1차 출력 텍스트에 2차 정답을 덮어써서 최종 텍스트 생성
function mergeFirstAndSecondPassText(firstLines, secondAnswers) {
  const lines = [...firstLines];
  const qSet = new Set(Object.keys(secondAnswers).map((k) => parseInt(k, 10)));

  function buildLine(q, idx) {
    const map = { 1: "A", 2: "B", 3: "C", 4: "D" };
    const letter = map[idx] || "?";
    return `${q}: ${letter}`;
  }

  // 기존 줄들에서 해당 번호 줄 찾아 교체
  for (const q of qSet) {
    const idxAns = secondAnswers[q];
    if (!idxAns) continue;

    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\d{1,3})\s*[:\-]/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n === q) {
          lines[i] = buildLine(q, idxAns);
          replaced = true;
          break;
        }
      }
    }
    // 기존에 없으면 UN SURE 줄 앞에 새로 추가
    if (!replaced) {
      const unsureIdx = lines.findIndex((l) => /^UNSURE\s*:/i.test(l));
      if (unsureIdx === -1) lines.push(buildLine(q, idxAns));
      else lines.splice(unsureIdx, 0, buildLine(q, idxAns));
    }
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
    const temperature = Number(process.env.TEMPERATURE ?? 0.1);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const ocrText = String(body.ocrText || body.text || "");

    if (!ocrText.trim()) {
      return json(400, { ok: false, error: "ocrText is empty" });
    }

    const ocrPreview = ocrText.slice(0, 400);

    // --------------------
    // 1차 패스: 전체 문항 풀이
    // --------------------
    const systemPromptFirst =
      "너는 한국 편입 영어 객관식 기출의 채점/정답키 생성 AI다.\n" +
      "- 입력: OCR로 인식된 시험지 원문 전체(여러 문항 포함).\n" +
      "- 출력 형식(반드시 지켜라):\n" +
      "  1) 각 문항마다 한 줄: '번호: 정답선지' (예: '13: B').\n" +
      "  2) 마지막 줄에 'UNSURE: 번호1, 번호2' 형식으로, 특히 불확실한 문항 번호를 나열한다. 없으면 'UNSURE: -'.\n" +
      "- 정답선지는 A/B/C/D 중 하나로만 쓴다. (숫자 대신 알파벳 권장)\n" +
      "- 불확실한 답은 해당 줄 끝에 '?'를 붙여라. (예: '13: B?')\n" +
      "- 그 외 해설, 설명, 마크다운, 공백 줄은 절대로 출력하지 마라.\n" +
      "- 보이는 모든 문항 번호에 대해 반드시 한 줄씩 답을 출력해야 한다 (문항 누락 금지).";

    const userPromptFirst =
      "다음은 편입 영어 시험의 OCR 텍스트다. 이 페이지에 보이는 모든 문항 번호에 대해 위 형식대로 정답을 예측해라.\n\n" +
      `[페이지 정보]\npage: ${page}\n\n` +
      "[OCR 텍스트]\n" +
      ocrText;

    let firstPass;
    try {
      firstPass = await callOpenRouter({
        apiKey,
        model,
        temperature,
        stopToken,
        messages: [
          { role: "system", content: systemPromptFirst },
          { role: "user", content: userPromptFirst },
        ],
        maxTokens: 512,
      });
    } catch (e) {
      return json(502, {
        ok: false,
        error: "OpenRouter error (first pass)",
        detail: String(e && e.message ? e.message : e),
        stage: "first-pass",
      });
    }

    const firstText = firstPass.text || "";
    if (!firstText.trim()) {
      return json(500, {
        ok: false,
        error: "Empty answer from model (first pass)",
        stage: "first-pass",
        dataPreview: firstPass.raw || null,
      });
    }

    const parsedFirst = parseAnswerText(firstText);
    const unsureOriginal = [...parsedFirst.unsureNumbers];
    const secondPassCandidates = parsedFirst.unsureNumbers;

    // --------------------
    // 2차 패스: UNSURE 문항 재풀이 (자동)
    // --------------------
    let secondPassUsed = false;
    let mergedText = firstText;
    let finalAnswers = { ...parsedFirst.answers };
    let finalQuestionNumbers = [...parsedFirst.questionNumbers];

    if (secondPassCandidates.length > 0) {
      secondPassUsed = true;

      const snippets = extractQuestionSnippets(ocrText, secondPassCandidates);
      let snippetsText = "";
      for (const q of secondPassCandidates) {
        snippetsText += `[Q${q}]\n${snippets[q]}\n\n`;
      }

      const systemPromptSecond =
        "너는 편입 영어 객관식 기출의 2차 재풀이 AI다.\n" +
        "- 입력: 전체 OCR 텍스트(참고용)와, 다시 풀어야 할 일부 문항의 OCR 스니펫.\n" +
        "- 할 일: 각 스니펫에 대해 A/B/C/D 중 최선의 정답을 고른다.\n" +
        "- 출력 형식(반드시 지켜라): 각 문항마다 한 줄 '번호: 정답선지' (예: '16: D').\n" +
        "- 마지막에 'UNSURE:' 줄은 절대 쓰지 마라.\n" +
        "- 불확실한 경우에는 해당 줄 끝에만 '?'를 붙여도 된다 (예: '16: D?').\n" +
        "- 그 외 설명/해설/마크다운/빈 줄은 절대 출력하지 마라.";

      const userPromptSecond =
        "다음은 이 페이지 전체의 OCR 텍스트다 (참고용이다, 필요하면 활용하되, 꼭 다 읽을 필요는 없다).\n\n" +
        "[전체 OCR 텍스트]\n" +
        ocrText +
        "\n\n" +
        "이 중에서 아래 질문 번호들만 다시 정확하게 풀어라:\n" +
        secondPassCandidates.join(", ") +
        "\n\n" +
        "각 질문 번호별 OCR 스니펫은 다음과 같다.\n\n" +
        snippetsText +
        "위 스니펫을 기반으로, 해당 질문 번호들의 정답만 위 형식대로 다시 출력하라.";

      let secondPass;
      try {
        secondPass = await callOpenRouter({
          apiKey,
          model,
          temperature,
          stopToken,
          messages: [
            { role: "system", content: systemPromptSecond },
            { role: "user", content: userPromptSecond },
          ],
          maxTokens: 256,
        });
      } catch (e) {
        // 2차가 실패해도 1차 결과는 그대로 반환
        return json(200, {
          ok: true,
          text: firstText,
          debug: {
            page,
            model,
            questionNumbers: parsedFirst.questionNumbers,
            answers: parsedFirst.answers,
            unsure: parsedFirst.unsureNumbers,
            unsureOriginal,
            secondPassUsed,
            secondPassError: String(e && e.message ? e.message : e),
            finishReasonFirst: firstPass.finishReason,
            finishReasonSecond: null,
            ocrTextPreview: ocrPreview,
          },
        });
      }

      const secondText = secondPass.text || "";
      const parsedSecond = parseAnswerText(secondText);

      // 2차에서 얻은 답만 덮어쓰기
      for (const [k, v] of Object.entries(parsedSecond.answers)) {
        const q = parseInt(k, 10);
        if (!Number.isFinite(q)) continue;
        finalAnswers[q] = v;
        if (!finalQuestionNumbers.includes(q)) finalQuestionNumbers.push(q);
      }

      finalQuestionNumbers.sort((a, b) => a - b);

      // 텍스트도 덮어쓴 정답으로 재구성 (UNSURE 줄은 1차 것 그대로 유지)
      mergedText = mergeFirstAndSecondPassText(parsedFirst.lines, parsedSecond.answers);

      return json(200, {
        ok: true,
        text: mergedText,
        debug: {
          page,
          model,
          questionNumbers: finalQuestionNumbers,
          answers: finalAnswers,
          unsure: parsedFirst.unsureNumbers, // 1차 기준 UNSURE 리스트는 남겨둔다.
          unsureOriginal,
          secondPassUsed,
          finishReasonFirst: firstPass.finishReason,
          finishReasonSecond: secondPass.finishReason,
          ocrTextPreview: ocrPreview,
        },
      });
    }

    // UNSURE 문항이 없으면 1패스 결과 그대로 반환
    return json(200, {
      ok: true,
      text: firstText,
      debug: {
        page,
        model,
        questionNumbers: parsedFirst.questionNumbers,
        answers: parsedFirst.answers,
        unsure: parsedFirst.unsureNumbers,
        unsureOriginal,
        secondPassUsed,
        finishReasonFirst: firstPass.finishReason,
        finishReasonSecond: null,
        ocrTextPreview: ocrPreview,
      },
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "solve.js top-level error",
      detail: String(e && e.message ? e.message : e),
    });
  }
};

