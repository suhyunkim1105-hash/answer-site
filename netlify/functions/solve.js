// netlify/functions/solve.js

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}
function text(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: String(body || ""),
  };
}

const SYSTEM_PROMPT = `
너는 "고려대 인문계 일반편입 인문논술 상위 1% 답안만 쓰는 전용 AI"다.

절대 규칙:
1) 한국어만 사용한다. 마크다운, 불릿, 번호 목록, 코드블록 금지.
2) 출력은 정확히 아래 두 블록만 포함한다.

[문제 1]
(1번 답안 문단)

[문제 2]
(2번 답안 문단)

3) [문제 1]은 400±50자(350~450자),
   [문제 2]는 1400±100자(1300~1500자) 분량으로 쓴다.
4) 해설/분석/코칭/자기언급/프롬프트·모델 언급 금지.
5) "이 글에서는" "먼저" 같은 메타 코멘트 금지.
`.trim();

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return text(405, "Method Not Allowed");
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { error: "Invalid JSON in request body" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, { error: "OPENROUTER_API_KEY is not set in Netlify environment variables" });
    }

    let ocrText = (body.ocrText || body.ocr_text || "").trim();
    const isLackSolve = !!body.is_lack_solve;

    if (!ocrText) {
      return json(400, { error: "ocrText (or ocr_text) is required" });
    }

    // ✅ 타임아웃/비어있는 응답 방지: 입력 강하게 줄임
    const MAX_CHARS = 4500;
    if (ocrText.length > MAX_CHARS) ocrText = ocrText.slice(0, MAX_CHARS);

    const userContent = `
다음은 OCR로 인식한 고려대 인문계 편입 논술 시험지 전체(제시문+문제)이다.
${isLackSolve ? "※ 지문이 완전하지 않을 수 있다. 남은 텍스트만으로 가능한 한 성실하게 답안을 완성하라.\n" : ""}

${ocrText}

규칙을 지키면서 [문제 1], [문제 2] 최종 답안만 작성하라.
`.trim();

    // ✅ Netlify 함수가 오래 붙잡히면 HTML(Inactivity Timeout) 뜰 수 있으니 Abort
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    let raw;
    try {
      const resp = await fetch(OPENROUTER_URL, {
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
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          temperature: 0.2,
          max_tokens: 1400,
        }),
        signal: controller.signal,
      });

      raw = await resp.text();

      // HTML 에러 그대로 반환(클라에서 표시 가능)
      if (raw && raw.trim().startsWith("<HTML")) {
        clearTimeout(timeout);
        return text(resp.status || 502, raw);
      }

      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        clearTimeout(timeout);
        return text(502, raw);
      }

      const answer =
        data?.choices?.[0]?.message?.content &&
        typeof data.choices[0].message.content === "string"
          ? data.choices[0].message.content.trim()
          : "";

      if (!answer) {
        // ✅ 한 번 더: 입력 더 줄여서 재시도
        const shorter = ocrText.slice(0, 2500);
        const resp2 = await fetch(OPENROUTER_URL, {
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
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: `OCR 텍스트가 일부만 있다.\n\n${shorter}\n\n규칙대로 [문제 1], [문제 2] 답안만 작성하라.`,
              },
            ],
            temperature: 0.2,
            max_tokens: 1400,
          }),
        });

        const raw2 = await resp2.text();
        if (raw2 && raw2.trim().startsWith("<HTML")) {
          clearTimeout(timeout);
          return text(resp2.status || 502, raw2);
        }

        let data2;
        try { data2 = JSON.parse(raw2); } catch (e) {
          clearTimeout(timeout);
          return text(502, raw2);
        }

        const answer2 =
          data2?.choices?.[0]?.message?.content &&
          typeof data2.choices[0].message.content === "string"
            ? data2.choices[0].message.content.trim()
            : "";

        clearTimeout(timeout);

        if (!answer2) {
          return json(200, { answer: "", error: "No answer (empty). Try shorter OCR / clearer capture." });
        }

        return json(200, { answer: answer2 });
      }

      clearTimeout(timeout);
      return json(200, { answer });

    } catch (e) {
      clearTimeout(timeout);
      const msg = (e && e.name === "AbortError")
        ? "Timeout calling OpenRouter (try shorter OCR text)"
        : ("Solve error: " + (e?.message || String(e)));
      return json(504, { error: msg, raw: raw ? raw.slice(0, 1000) : "" });
    }

  } catch (err) {
    return json(500, { error: "Server error: " + (err?.message || String(err)) });
  }
};

