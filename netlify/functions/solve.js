// netlify/functions/solve.js

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

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

function cleanForEssay(text) {
  text = String(text || "");
  text = text.replace(/[A-Za-z0-9]/g, ""); // 영문/숫자 제거
  text = text.replace(/[^가-힣\s\n\.\,\?\!\:\;\(\)\[\]\"\'·\-\—\…]/g, ""); // 기본 문장부호만
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// 앞+뒤만 남기기(문제/질문이 뒤에 있어도 살림)
function headTailTrim(text, maxChars) {
  text = String(text || "").trim();
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.7);
  const tailLen = maxChars - headLen;
  return (text.slice(0, headLen) + "\n\n(중간 생략)\n\n" + text.slice(-tailLen)).trim();
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
      return json(400, { error: "Invalid JSON" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return json(500, { error: "OPENROUTER_API_KEY not set" });

    let ocrText = String(body.ocrText || "").trim();
    if (!ocrText) return json(400, { error: "ocrText is required" });

    // ✅ 타임아웃 방지 핵심: 아주 짧게 + 깨끗하게
    ocrText = cleanForEssay(ocrText);
    const trimmed = headTailTrim(ocrText, 900); // 900자만 보냄(매우 중요)

    const SYSTEM_PROMPT = `
너는 "고려대 인문계 일반편입 인문논술 상위 1% 답안만 쓰는 AI"다.
한국어만. 마크다운/목록/번호/메타코멘트 금지.
출력은 정확히 아래 2블록만.

[문제 1]
(350~450자)

[문제 2]
(1300~1500자)
`.trim();

    const userPrompt = `
다음은 OCR 시험지 텍스트(일부 생략 가능)이다.

${trimmed}

규칙을 지켜 [문제 1], [문제 2] 최종 답안만 출력하라.
`.trim();

    const payload = {
      model: "openrouter/auto",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 650, // ✅ 더 줄임(속도↑, 타임아웃↓)
    };

    let resp;
    try {
      // ✅ 7초 컷: Netlify 10초 제한 대비
      resp = await fetchWithTimeout(
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
        7000
      );
    } catch (e) {
      // AbortError 포함
      return json(200, {
        answer:
          "충분한 지문 인식으로 자동 풀이합니다.\n\n(서버 시간 제한으로 이번 요청이 중단되었습니다. OCR 텍스트를 더 짧게/깨끗하게 만든 뒤 다시 시도하세요.)",
        error: "timeout_or_network",
      });
    }

    const raw = await resp.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // OpenRouter/프록시가 HTML을 준 경우
      return json(200, {
        answer:
          "충분한 지문 인식으로 자동 풀이합니다.\n\n(서버가 JSON이 아닌 응답을 반환했습니다. 다시 시도하세요.)\n\n" +
          raw.slice(0, 300),
        error: "non_json_response",
      });
    }

    if (!resp.ok) {
      const msg = data?.error?.message || data?.error || raw.slice(0, 200);
      return json(200, {
        answer:
          "충분한 지문 인식으로 자동 풀이합니다.\n\n(모델 호출 에러: " + msg + ")\n\n입력을 더 줄여 다시 시도하세요.",
        error: "openrouter_error",
      });
    }

    const answer =
      data?.choices?.[0]?.message?.content &&
      typeof data.choices[0].message.content === "string"
        ? data.choices[0].message.content.trim()
        : "";

    if (!answer) {
      return json(200, {
        answer:
          "충분한 지문 인식으로 자동 풀이합니다.\n\nNo answer (모델 응답 비어있음). 입력을 더 줄여서 다시 시도",
        error: "empty_answer",
      });
    }

    return json(200, { answer });

  } catch (err) {
    return json(500, { error: "Server error", message: String(err?.message || err) });
  }
};

