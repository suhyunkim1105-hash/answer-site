export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "요청 JSON 파싱 실패" }, 400);
  }

  const base64Image = body?.base64Image; // "data:image/jpeg;base64,...."
  const page = body?.page ?? null;

  const apiKey = process.env.OCRSPACE_API_KEY;
  const endpoint = process.env.OCRSPACE_ENDPOINT || "https://api.ocr.space/parse/image";

  if (!apiKey) {
    return json(
      {
        ok: false,
        error:
          "OCRSPACE_API_KEY 환경변수가 비어있습니다. Netlify 환경변수에 OCRSPACE_API_KEY를 넣고 재배포하세요.",
      },
      500
    );
  }

  if (!base64Image || typeof base64Image !== "string" || !base64Image.startsWith("data:")) {
    return json({ ok: false, error: "base64Image가 없습니다(또는 형식이 아닙니다)." }, 400);
  }

  // OCR.Space POST 파라미터: apikey(헤더), base64Image, language 등 
  const form = new FormData();
  form.append("base64Image", base64Image);
  form.append("language", "kor");
  form.append("OCREngine", "1");     // 한국어는 엔진1 권장 
  form.append("scale", "true");     // 저해상도/작은 글자 개선 옵션 
  form.append("isOverlayRequired", "false");

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 25000);

  let resp, text;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: apiKey, // 문서: apikey는 헤더로 전송 
      },
      body: form,
      signal: ac.signal,
    });
    text = await resp.text();
  } catch (e) {
    clearTimeout(t);
    return json(
      { ok: false, error: "OCR.Space 호출 실패(네트워크/타임아웃)", detail: String(e) },
      502
    );
  } finally {
    clearTimeout(t);
  }

  if (!resp.ok) {
    // 여기서 403이면 거의 "키 미전달/키 불일치/엔드포인트 불일치"다.
    return json(
      {
        ok: false,
        error: `OCR.Space 응답 오류(HTTP ${resp.status})`,
        page,
        endpoint,
        hint:
          resp.status === 403
            ? "403은 보통 API 키가 요청에 안 실리거나(환경변수 이름 불일치/재배포 안함), PRO 엔드포인트/키 조합 문제입니다."
            : "OCR.Space 상태/요청 파라미터를 확인하세요.",
        raw: safeSlice(text, 1200),
      },
      502
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "OCR.Space JSON 파싱 실패", raw: safeSlice(text, 1200) }, 502);
  }

  const parsed =
    data?.ParsedResults?.[0]?.ParsedText?.trim?.() ??
    "";

  if (!parsed) {
    return json(
      {
        ok: false,
        error: "페이지 OCR 결과가 비어있음",
        page,
        rawErrorMessage: data?.ErrorMessage ?? null,
        raw: data,
      },
      200
    );
  }

  return json(
    {
      ok: true,
      page,
      text: parsed,
      // 디버그용: 엔진/스케일 적용 여부 등 확인
      meta: {
        endpoint,
        ocrEngine: 1,
        scale: true,
      },
    },
    200
  );
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function safeSlice(s, n) {
  if (!s || typeof s !== "string") return "";
  return s.length > n ? s.slice(0, n) + "…(truncated)" : s;
}

