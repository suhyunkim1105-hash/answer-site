export default async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "요청 JSON 파싱 실패" }, 400);
  }

  const ocrText = (body?.ocrText ?? "").trim();
  if (!ocrText) return json({ ok: false, error: "ocrText가 비어있습니다." }, 400);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return json({ ok: false, error: "OPENROUTER_API_KEY 환경변수가 비어있습니다." }, 500);
  }

  const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
  const charTarget = Number(body?.charTarget ?? 1000);
  const charTolerance = Number(body?.charTolerance ?? 50);

  const system = `
너는 '연세대 사회계열/사회복지 관점' 논술 상위권 답안을 작성하는 도우미다.
출력 규칙:
- 한국어로만 작성한다.
- 마크다운/글머리표/번호매기기 금지.
- 아래 두 블록만 출력한다:
[문제 1] ...본문...
[문제 2] ...본문...
- 각 블록 분량은 대략 ${charTarget}자 내외(±${charTolerance})로 맞춘다.
- '~한다' 문체로 쓴다.
- 제시문/도표 내용이 OCR 텍스트에 있으면 반드시 반영한다(임의로 수치 만들어내지 않는다).
`.trim();

  const user = `
다음은 OCR로 인식된 시험지 전체 텍스트다. (제시문/문항/도표설명 포함 가능)
텍스트를 기반으로 [문제 1], [문제 2] 답안을 작성하라.

=== OCR TEXT START ===
${ocrText}
=== OCR TEXT END ===
`.trim();

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 25000);

  let resp, data;
  try {
    resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: ac.signal,
    });

    data = await resp.json();
  } catch (e) {
    clearTimeout(t);
    return json({ ok: false, error: "OpenRouter 호출 실패(네트워크/타임아웃)", detail: String(e) }, 502);
  } finally {
    clearTimeout(t);
  }

  if (!resp.ok) {
    return json(
      { ok: false, error: `OpenRouter 응답 오류(HTTP ${resp.status})`, raw: data },
      502
    );
  }

  const out = data?.choices?.[0]?.message?.content?.trim?.() ?? "";
  if (!out) return json({ ok: false, error: "모델 출력이 비어있습니다.", raw: data }, 502);

  return json({ ok: true, answer: out }, 200);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

