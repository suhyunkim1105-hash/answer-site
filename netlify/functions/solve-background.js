// netlify/functions/solve-background.js
// 백그라운드 함수: 오래 걸려도(최대 15분) 브라우저 연결이 안 끊기게 설계
// 필요 env: OPENROUTER_API_KEY

const FIREBASE_DB_URL = "https://answer-site-p2p-default-rtdb.asia-southeast1.firebasedatabase.app";

function now() { return Date.now(); }

function stripNoise(s) {
  return (s || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 너무 길면 “중복 줄 제거 + 상위 일부 유지”로 압축(속도/안정성 ↑)
function compactOcrText(text, maxChars) {
  const lines = stripNoise(text).split("\n").map(l => l.trim()).filter(Boolean);

  const seen = new Set();
  const out = [];

  for (const l of lines) {
    const key = l.replace(/\s/g, "").slice(0, 24);
    if (key.length < 8) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
    if (out.join("\n").length > maxChars) break;
  }

  return out.join("\n").slice(0, maxChars);
}

async function fbWriteJob(jobId, obj) {
  const url = `${FIREBASE_DB_URL}/p2p/jobs/${encodeURIComponent(jobId)}.json`;
  await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  });
}

async function callOpenRouter(apiKey, systemPrompt, userPrompt) {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
      "X-Title": "autononsul",
    },
    body: JSON.stringify({
      model: "openrouter/auto",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.4,
      max_tokens: 2600
    }),
  });

  const raw = await resp.text();
  let data;
  try { data = JSON.parse(raw); }
  catch (e) {
    return { ok: false, error: "Non-JSON from OpenRouter", raw: raw.slice(0, 600), status: resp.status };
  }

  const answer =
    data?.choices?.[0]?.message?.content && typeof data.choices[0].message.content === "string"
      ? data.choices[0].message.content.trim()
      : "";

  if (!resp.ok) {
    return { ok: false, error: data?.error?.message || "OpenRouter error", raw: raw.slice(0, 600), status: resp.status };
  }

  if (!answer) {
    return { ok: false, error: "No answer from model", raw: raw.slice(0, 600), status: resp.status };
  }

  return { ok: true, answer };
}

exports.handler = async (event) => {
  // 백그라운드는 호출 즉시 202를 반환하고 뒤에서 계속 실행됨
  // (Netlify가 백그라운드로 처리) 
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}

  const jobId = (body.jobId || "").trim();
  const ocrText = (body.ocrText || "").trim();

  // 먼저 202를 돌려주기 위한 “즉시 응답”
  const immediateResponse = {
    statusCode: 202,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ok: true, jobId })
  };

  // 여기부터 백그라운드 실제 작업
  (async () => {
    try {
      if (!jobId) return;
      await fbWriteJob(jobId, { status: "running", updatedAt: now() });

      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        await fbWriteJob(jobId, { status: "error", message: "OPENROUTER_API_KEY가 설정되지 않음", updatedAt: now() });
        return;
      }

      if (!ocrText) {
        await fbWriteJob(jobId, { status: "error", message: "ocrText가 비어있음", updatedAt: now() });
        return;
      }

      // 1차: 최대한 크게(품질 우선)
      const trimmed1 = compactOcrText(ocrText, 8000);

      const SYSTEM_PROMPT = `
지금부터 너는 “고려대 인문계 일반편입 인문논술 상위 1% 답안만 쓰는 전용 AI”이다.
규칙:
1) 한국어만. 마크다운/불릿/번호목록/코드블록 금지.
2) 출력은 오직 아래 두 블록만:
[문제 1]
(1번 답안)
[문제 2]
(2번 답안)
3) [문제 1] 400±50자, [문제 2] 1400±100자.
4) 해설/분석/자기언급/메타 멘트/모델·프롬프트 언급 금지.
5) 논제 요구를 빠짐없이 수행. 개념→사례→판단. 양면평가 기본값.
`.trim();

      const user1 = `
다음은 OCR로 인식한 고려대 인문계 일반편입 인문논술 시험지 전체 텍스트이다.

${trimmed1}

위 시험지에 대해 규칙을 지키며 [문제 1], [문제 2] 최종 답안만 작성하라.
`.trim();

      let r = await callOpenRouter(apiKey, SYSTEM_PROMPT, user1);

      // 2차 재시도: 응답이 비면 입력을 더 줄여서 “무조건 답 나오게”
      if (!r.ok) {
        const trimmed2 = compactOcrText(ocrText, 4200);
        const user2 = `
다음은 OCR로 인식한 시험지 텍스트(요약본)이다.

${trimmed2}

규칙을 지키며 [문제 1], [문제 2] 최종 답안만 작성하라.
`.trim();
        r = await callOpenRouter(apiKey, SYSTEM_PROMPT, user2);
      }

      if (!r.ok) {
        await fbWriteJob(jobId, { status: "error", message: `${r.error} (status=${r.status || "?"})`, updatedAt: now(), debug: r.raw || "" });
        return;
      }

      await fbWriteJob(jobId, { status: "done", answer: r.answer, updatedAt: now() });

    } catch (e) {
      try {
        if (jobId) await fbWriteJob(jobId, { status: "error", message: e.message || String(e), updatedAt: now() });
      } catch(_) {}
    }
  })();

  return immediateResponse;
};
