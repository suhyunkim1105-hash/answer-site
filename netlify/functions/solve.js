// netlify/functions/solve.js
// OpenRouter를 통해 객관식 정답만 계산하는 함수
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }
    const body = safeJson(event.body);
    const questions = Array.isArray(body.questions) ? body.questions : [];
    if (!questions.length) {
      return json(200, { ok: false, error: "questions 배열이 비어 있음" });
    }

    const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
    if (!apiKey) {
      return json(500, { ok: false, error: "OPENROUTER_API_KEY env 없음" });
    }
    const model =
      (process.env.OPENROUTER_MODEL || "").trim() || "openai/gpt-4.1";

    const prompt = buildPrompt(questions);

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site-autonnonsul"
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 512,
        messages: [
          {
            role: "system",
            content:
              "You are an answer-checking engine for Korean university transfer English multiple choice exams. " +
              "ONLY return compact JSON with the correct choice index (1-5) for each question. " +
              "JSON format: {\"answers\":{\"1\":3,\"2\":1,...}}. No explanation, no extra keys."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    if (!resp.ok) {
      return json(200, {
        ok: false,
        error: "OpenRouter HTTP error " + resp.status
      });
    }

    const data = await resp.json();
    const raw = data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;

    const parsed = parseAnswers(raw);
    if (!parsed || !parsed.answers) {
      return json(200, {
        ok: false,
        error: "failed to parse answers",
        raw
      });
    }

    return json(200, { ok: true, answers: parsed.answers });
  } catch (e) {
    return json(200, {
      ok: false,
      error: e && e.message ? e.message : String(e)
    });
  }
}

function buildPrompt(questions) {
  // 질문 + 보기 그대로 넘긴다.
  const parts = questions.map(q => {
    const num = q.number;
    const stem = (q.stem || "").trim();
    const choices = (q.choices || [])
      .map((c, idx) => {
        const opt = idx + 1;
        return opt + ") " + String(c || "").trim();
      })
      .join("\n");
    return (
      "Q" +
      num +
      ". " +
      stem +
      "\n" +
      choices +
      "\n정답 번호(1-5)만 고르시오."
    );
  });

  return (
    "다음은 한국 편입 영어 객관식 시험 문항이다. 각 문항은 보기 5개(1-5번) 중 하나가 정답이다. " +
    "각 문항의 정답 번호만 판단해서 JSON으로만 답변하라. 예시: {\"answers\":{\"1\":3,\"2\":1,...}}. " +
    "설명, 문장, 자연어를 한 글자도 넣지 마라. 오직 JSON 한 줄만 출력하라.\n\n" +
    parts.join("\n\n")
  );
}

function parseAnswers(text) {
  if (!text || typeof text !== "string") return null;

  let jsonText = text.trim();

  // 모델이 코드블록으로 감쌀 경우 제거
  if (jsonText.startsWith("```")) {
    const m = jsonText.match(/```(?:json)?([\s\S]*?)```/i);
    if (m) jsonText = m[1].trim();
  }

  try {
    const obj = JSON.parse(jsonText);
    if (obj && obj.answers && typeof obj.answers === "object") {
      return { answers: obj.answers };
    }
  } catch (_) {
    // fallthrough
  }

  // JSON 파싱 실패 시, 숫자 패턴에서라도 뽑아본다.
  const ans = {};
  const re = /\"?(\d{1,2})\"?\s*[:=]\s*\"?([1-5])\"?/g;
  let m;
  while ((m = re.exec(jsonText))) {
    ans[m[1]] = Number(m[2]);
  }
  if (Object.keys(ans).length) {
    return { answers: ans };
  }
  return null;
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
