// netlify/functions/solve.js

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function headTailTrim(text, maxChars) {
  text = String(text || "").trim();
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.7);
  const tailLen = maxChars - headLen;
  return (text.slice(0, headLen) + "\n\n(중간 생략)\n\n" + text.slice(-tailLen)).trim();
}

// 숫자/영문/잡기호 강하게 제거해서 토큰+노이즈 줄임
function cleanForEssay(text) {
  text = String(text || "");
  text = text.replace(/[A-Za-z0-9]/g, ""); // 영문/숫자 제거
  text = text.replace(/[^가-힣\s\n\.\,\?\!\:\;\(\)\[\]\"\'·\-\—\…]/g, ""); // 기본 문장부호만
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
    },
    body: JSON.stringify(obj),
  };
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "POST,OPTIONS",
        },
        body: "",
      };
    }

    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON in request body" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, { error: "OPENROUTER_API_KEY is not set in Netlify environment" });
    }

    let ocrText = String(body.ocrText || "").trim();
    if (!ocrText) return json(400, { error: "ocrText is required" });

    // ✅ 핵심: 입력을 “짧고 깨끗하게”
    ocrText = cleanForEssay(ocrText);

    // ✅ 더 짧게 보냄(타임아웃 방지): 1400자 → 실패 시 900자 재시도
    const INPUT1 = headTailTrim(ocrText, 1400);
    const INPUT2 = headTailTrim(ocrText, 900);

    const SYSTEM_PROMPT = `
너는 "고려대 인문계 일반편입 인문논술 상위 1% 답안만 쓰는 AI"다.
한국어만. 마크다운/목록/번호/메타코멘트 금지.
출력은 정확히 아래 2블록만.

[문제 1]
(350~450자)

[문제 2]
(1300~1500자)
`.trim();

    async function callOnce(inputText, attempt) {
      const userPrompt = `
다음은 OCR 시험지 텍스트(일부 생략 가능)이다.

${inputText}

규칙을 지켜 [문제 1], [문제 2] 최종 답안만 출력하라.
`.trim();

      const payload = {
        model: "openrouter/auto",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 900, // ✅ 응답 빨리 나오게
      };

      // ✅ 12초 안에 응답 못 받으면 즉시 중단하고 에러 반환 (Netlify 504 회피)
      const resp = await fetchWithTimeout(
        OPENROUTER_URL,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
            "X-Title": "autononsul",
          },
          body: JSON.stringify(payload),
        },
        12000
      );

      const raw = await resp.text();

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return { ok: false, status: resp.status, error: raw.slice(0, 400) };
      }

      if (!resp.ok) {
        const msg = data?.error?.message || data?.error || raw.slice(0, 300);
        return { ok: false, status: resp.status, error: msg };
      }

      const answer =
        data?.choices?.[0]?.message?.content &&
        typeof data.choices[0].message.content === "string"
          ? data.choices[0].message.content.trim()
          : "";

      if (!answer) {
        return { ok: false, status: 200, error: "No answer (모델 응답 비어있음)" };
      }

      return { ok: true, status: 200, answer };
    }

    // 1차
    let r1;
    try {
      r1 = await callOnce(INPUT1, 1);
      if (r1.ok) return json(200, { answer: r1.answer });
    } catch (e) {
      r1 = { ok: false, status: 500, error: String(e?.message || e) };
    }

    // 2차(더 줄여 재시도)
    let r2;
    try {
      r2 = await callOnce(INPUT2, 2);
      if (r2.ok) return json(200, { answer: r2.answer });
    } catch (e) {
      r2 = { ok: false, status: 500, error: String(e?.message || e) };
    }

    return json(500, {
      error: "solve failed (timeout/slow)",
      attempt1: { status: r1.status, error: r1.error },
      attempt2: { status: r2.status, error: r2.error },
      tip: "Netlify 504가 계속이면: 더 짧게 보내야 함(OCR 누적 텍스트 줄이기) 또는 네트워크 불안정일 수 있음.",
    });

  } catch (err) {
    return json(500, { error: "Server error", message: String(err?.message || err) });
  }
};

