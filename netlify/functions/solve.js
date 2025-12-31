// netlify/functions/solve.js
export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "POST only" }) };
    }

    // ✅ 변수명 두 개 다 허용
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
    if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: "Missing OPENROUTER_API_KEY" }) };

    const model = process.env.OPENROUTER_MODEL || "openai/gpt-5.2-thinking";
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

    const text = body.text;
    if (!text || typeof text !== "string" || text.trim().length < 300) {
      return { statusCode: 400, body: JSON.stringify({ error: "text required" }) };
    }

    // ====== 핵심: OCR 텍스트 구조 복원(1~5 밑줄/라벨, 6~ 선지 라벨링) ======
    function normalizeForModel(raw) {
      let s = raw;

      // 노이즈 줄(광고/짧은 숫자 뭉치) 완화
      s = s.replace(/^\s*\d{6,}\s*$/gm, "");
      s = s.replace(/^\s*(Biscoff|Available in a\s*supermarket near you)\s*$/gmi, "");
      s = s.replace(/[^\S\r\n]+/g, " ");
      s = s.replace(/\n{3,}/g, "\n\n");

      // (1) 1~5: 문장 내 마커(@ © ® O 0 • *)를 등장 순서대로 (A)(B)(C)(D)(E)로 치환
      // 문제마다 01~05 라인을 찾아서 해당 줄만 치환
      const markerRe = /[@©®ΟO0•\*]/g; // 그럴듯한 후보들(완전무결은 아님)
      s = s.replace(/(^\s*0?[1-5]\s+.*$)/gm, (line) => {
        let idx = 0;
        const labels = ["(A)","(B)","(C)","(D)","(E)"];
        return line.replace(markerRe, () => labels[idx++] || "(E)");
      });

      // (2) 선지 라벨이 깨진 경우: "• , @, ®, ©, *" 등으로 시작하는 짧은 줄 5개를 A~E로 재라벨
      // 완벽 파서 대신, 모델이 보기 좋게 "A) ..." 형태를 강제로 만들어줌
      const lines = s.split("\n");
      const out = [];
      let optBuf = [];

      function flushOpts() {
        if (optBuf.length >= 3) {
          const labels = ["A) ","B) ","C) ","D) ","E) "];
          const trimmed = optBuf.slice(0,5).map(x => x.trim().replace(/^[•\*@©®\d]+\s*/,""));
          for (let i=0;i<trimmed.length;i++) out.push(labels[i] + trimmed[i]);
        } else {
          for (const x of optBuf) out.push(x);
        }
        optBuf = [];
      }

      for (let i=0;i<lines.length;i++) {
        const L = lines[i];

        // 다음 문제 번호가 나오면 옵션 버퍼를 털어줌
        if (/^\s*(?:0?\d|1\d|2[0-5])\b/.test(L) && optBuf.length) {
          flushOpts();
        }

        const isOptionLike =
          /^[\s•\*@©®\d]{0,3}[A-Za-z][^\n]{0,60}$/.test(L.trim()) &&
          !/^\s*\[PAGE\s+\d+\]/i.test(L);

        // "선지처럼 보이는 짧은 라인"을 모으되, 문장 길면 제외
        if (isOptionLike && L.trim().length <= 45) {
          optBuf.push(L);
          continue;
        }

        // 옵션이 끝난 뒤 일반 문장이 나오면 털기
        if (optBuf.length && L.trim().length > 60) {
          flushOpts();
        }

        out.push(L);
      }
      if (optBuf.length) flushOpts();

      return out.join("\n");
    }

    const normalized = normalizeForModel(text);

    const system = `
너는 영어 객관식 시험 풀이 AI다.
반드시 아래 형식의 "유효한 JSON만" 출력한다. 그 외 텍스트 금지.

{"answers":{"1":"A","2":"B",...}}

규칙:
- 답은 A,B,C,D,E만.
- 모르면 추측하지 말고 그 번호는 "생략".
- 1~5번은 (A)(B)(C)(D)로 표시된 밑줄/구간 중 "오류"를 고르는 문제다.
- 나머지는 문맥+선지로 정답을 고른다.
`;

    const user = `다음 OCR 텍스트를 보고 1~25번을 풀어라. 오직 JSON만 반환하라.\n\n${normalized}`;

    async function callOR(messages) {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages,
        }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) throw new Error(j?.error?.message || "OpenRouter failed");
      return j.choices?.[0]?.message?.content ?? "";
    }

    function extractJson(s) {
      const t = (s || "").trim();
      try { return JSON.parse(t); } catch {}
      const a = t.indexOf("{"), b = t.lastIndexOf("}");
      if (a !== -1 && b !== -1 && b > a) {
        try { return JSON.parse(t.slice(a, b+1)); } catch {}
      }
      return null;
    }

    function normalizeAnswers(obj) {
      const answers = obj?.answers;
      if (!answers || typeof answers !== "object") return null;
      const out = {};
      for (const [k,v] of Object.entries(answers)) {
        const kk = String(k).replace(/\D/g,"");
        const vv = String(v).trim().toUpperCase();
        if (!kk) continue;
        if (!["A","B","C","D","E"].includes(vv)) continue;
        out[String(Number(kk))] = vv;
      }
      return Object.keys(out).length ? out : null;
    }

    // 1차
    const c1 = await callOR([{role:"system",content:system},{role:"user",content:user}]);
    let obj = extractJson(c1);
    let answers = normalizeAnswers(obj);

    // 2차(형식 실패 시)
    if (!answers) {
      const c2 = await callOR([
        {role:"system",content:system},
        {role:"user",content:user},
        {role:"assistant",content:c1},
        {role:"user",content:"유효한 JSON만 다시 출력해. 스키마를 반드시 지켜."},
      ]);
      obj = extractJson(c2);
      answers = normalizeAnswers(obj);
      if (!answers) {
        return { statusCode: 502, body: JSON.stringify({ error: "Model output not parseable", raw: c2 }) };
      }
    }

    const keys = Object.keys(answers).map(Number).filter(n=>!Number.isNaN(n)).sort((a,b)=>a-b);
    const answer_text = keys.map(k => `${k}번: ${answers[String(k)]}`).join("\n");

    return { statusCode: 200, body: JSON.stringify({ answers, answer_text }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || "unknown" }) };
  }
};


