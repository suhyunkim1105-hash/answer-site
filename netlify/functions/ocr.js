// netlify/functions/ocr.js

// Netlify 함수: 클라이언트에서 보낸 base64 이미지를 OCR.Space PRO로 보내서
// 텍스트만 정리해서 돌려주는 역할을 한다.

exports.handler = async (event) => {
  // 1) POST 이외는 막기
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED" }),
    };
  }

  // 2) 환경변수에서 PRO 키 읽기
  const apiKey = process.env.OCRSPACE_API_KEY;
  if (!apiKey) {
    // Netlify 환경변수 미설정
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        ok: false,
        error: "NO_API_KEY",
        hint: "Netlify 환경변수 OCRSPACE_API_KEY 가 설정되어 있지 않습니다.",
      }),
    };
  }

  // 3) 클라이언트에서 받은 body 파싱
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        ok: false,
        error: "INVALID_JSON",
        hint: "클라이언트에서 보낸 JSON 형식이 잘못되었습니다.",
      }),
    };
  }

  const { imageBase64 } = body;

  if (!imageBase64) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        ok: false,
        error: "NO_IMAGE",
        hint: "imageBase64 필드가 비어 있습니다.",
      }),
    };
  }

  // 4) PRO 엔드포인트 (1차 / 2차)
  const PRIMARY_ENDPOINT = "https://apipro1.ocr.space/parse/image";
  const BACKUP_ENDPOINT = "https://apipro2.ocr.space/parse/image";

  async function callOcr(endpoint) {
    // OCR.Space는 base64Image 파라미터에 dataURL 형식 그대로 넣어도 인식 가능
    const form = new URLSearchParams();
    form.append("apikey", apiKey);
    form.append("language", "kor+eng");        // 한글 + 영어
    form.append("scale", "true");
    form.append("OCREngine", "2");
    form.append("isOverlayRequired", "false");
    form.append("base64Image", imageBase64);   // data:image/jpeg;base64,... 그대로

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    const raw = await res.text(); // 나중에 디버깅용으로 그대로 돌려줌
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      // JSON 파싱 실패 시 json은 null로 둔다.
    }

    // OCR 결과에서 텍스트 뽑기
    let parsedText = "";
    if (json && Array.isArray(json.ParsedResults)) {
      parsedText = json.ParsedResults
        .map((r) => (r.ParsedText || "").trim())
        .join("\n\n")
        .trim();
    }

    const isErrored = json?.IsErroredOnProcessing === true;

    return {
      httpStatus: res.status,       // OCR.Space 응답 코드 (200, 403 등)
      raw,
      json,
      parsedText,
      ok: res.ok && !isErrored && parsedText.length > 0,
      ocrErrorMessage: json?.ErrorMessage || json?.ErrorDetails || null,
    };
  }

  // 5) 먼저 apipro1 호출, 에러면 apipro2 백업 호출
  let result;
  try {
    result = await callOcr(PRIMARY_ENDPOINT);

    // 403, 5xx, 혹은 텍스트가 전혀 안 나온 경우 → 백업 엔드포인트 한 번 더 시도
    if (
      !result.ok &&
      (result.httpStatus === 403 ||
        result.httpStatus >= 500 ||
        !result.parsedText)
    ) {
      const backupResult = await callOcr(BACKUP_ENDPOINT);
      // 백업 쪽이 더 나으면 교체
      if (backupResult.ok || backupResult.parsedText.length > result.parsedText.length) {
        result = backupResult;
      }
    }
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        ok: false,
        error: "OCR_REQUEST_FAILED",
        hint: "OCR.Space 호출 중 네트워크 오류가 발생했습니다.",
        detail: String(e),
      }),
    };
  }

  // 6) 클라이언트로 전달 (항상 200으로 보내고, 내부 상태는 ok/ocrStatus로 구분)
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      ok: result.ok,
      ocrStatus: result.httpStatus,      // 프론트에서 "HTTP 403" 이런 식으로 보여 줄 때 사용
      text: result.parsedText,          // 실제 인식된 텍스트
      raw: result.raw,                  // 디버깅용 원본 응답 (로그용)
      ocrErrorMessage: result.ocrErrorMessage,
    }),
  };
};


