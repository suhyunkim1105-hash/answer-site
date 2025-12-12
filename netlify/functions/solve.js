// netlify/functions/solve.js

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// ✅ 입력을 "앞+뒤"로 잘라서 문제/질문이 끝에 있어도 살림
function headTailTrim(text, maxChars) {
  text = String(text || "").trim();
  if (text.length <= maxChars) return text;

  const headLen = Math.floor(maxChars * 0.65);
  const tailLen = maxChars - headLen;

  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);

  return `${head}\n\n(중간 생략)\n\n${tail}`.trim();
}

// ✅ 불필요한 기호/영문/숫자 제거(토큰 절약 + 잡음 감소)
// 필요하면 주석처리 가능
function cleanForEssay(text) {
  text = String(text || "");
  text = text.replace(/[A-Za-z0-9]/g, ""); // 영문/숫자 제거
  text = text.replace(/[^가-힣\s\n\.\,\?\!\:\;\(\)\[\]\"\'·\-\—\…]/g, ""); // 기본 문장부호만 허용
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
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
    if (!ocrText) {
      return json(400, { error: "ocrText is required" });
    }

    // ✅ 입력 노이즈 제거 + 길이 줄이기 (타임아웃 방지 핵심)
    ocrText = cleanForEssay(ocrText);

    // 1차: 2600자 정도로 앞+뒤만
    const INPUT1 = headTailTrim(ocrText, 2600);
    // 2차(재시도): 더 강하게 1700자로
    const INPUT2 = headTailTrim(ocrText, 1700);

    const SYSTEM_PROMPT = `
너는 "고려대 인문계 일반편입 인문논술 상위 1% 답안만 쓰는 AI"다.

규칙:
1) 한국어만 사용한다. 마크다운, 불릿, 번호 목록, 코드블록을 쓰지 않는다.
2) 출력은 정확히 아래 두 블록만 포함한다.

[문제 1]
(1번 답안 문단)

[문제 2]
(2번 답안 문단)

3) [문제 1]은 400±50자(350~450자),
   [문제 2]는 1400±100자(1300~1500자) 분량으로 쓴다.
4) 개요, 해설, 구조 설명, 채점, 자기 언급, 프롬프트/모델 언급,
   "이 글에서는 ~을 하겠다", "먼저 ~을 살펴보자" 같은 메타 코멘트는 절대 쓰지 않는다.
`.trim();

    async function callOnce(trimmedInput, attemptNo) {
      const userContent = `
다음은 OCR로 인식한 고려대 인문계 편입 논술 시험지 전체(일부 생략 가능)이다.

${trimmedInput}

위 시험지에 대해, 규칙을 지키면서 [문제 1], [문제 2] 최종 답안만 작성하라.
`.trim();

      const payload = {
        model: "openrouter/auto",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: attemptNo === 1 ? 0.4 : 0.2,
        max_tokens: attemptNo === 1 ? 1200 : 1100, // ✅ 너무 크게 잡지 마(타임아웃 원인)
      };

      // ✅ 22초 타임아웃(넷리파이 504/timeout 회피)
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
        22000
      );

      const raw = await resp.text();

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        // OpenRouter/프록시가 HTML을 줄 때
        return { ok: false, status: resp.status, error: raw.slice(0, 500) };
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

    // ✅ 1차 시도
    let r1;
    try {
      r1 = await callOnce(INPUT1, 1);
      if (r1.ok) return json(200, { answer: r1.answer });
    } catch (e) {
      r1 = { ok: false, status: 500, error: String(e?.message || e) };
    }

    // ✅ 2차: 입력 더 줄여서 재시도
    let r2;
    try {
      r2 = await callOnce(INPUT2, 2);
      if (r2.ok) return json(200, { answer: r2.answer });
    } catch (e) {
      r2 = { ok: false, status: 500, error: String(e?.message || e) };
    }

    // 둘 다 실패
    return json(500, {
      error: "solve failed",
      attempt1: { status: r1.status, error: r1.error },
      attempt2: { status: r2.status, error: r2.error },
      hint: "입력이 너무 길거나(토큰/시간), OpenRouter 일시 오류일 수 있음. OCR 누적 텍스트를 더 정리하거나(기호 제거), 다시 시도.",
    });

  } catch (err) {
    return json(500, { error: "Server error", message: String(err?.message || err) });
  }
};

