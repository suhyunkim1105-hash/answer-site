// netlify/functions/ocr.js

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

exports.handler = async (event) => {
  // 1) POST만 허용
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({
        ok: false,
        error: 'METHOD_NOT_ALLOWED',
        message: 'POST로 호출해야 합니다.',
      }),
    };
  }

  // 2) body 파싱
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        ok: false,
        error: 'INVALID_JSON',
        message: '요청 body가 JSON 형식이 아닙니다.',
        raw: event.body,
      }),
    };
  }

  const imageBase64 = body.imageBase64;
  const pageIndex = body.pageIndex ?? 1;

  // 3) 이미지 없을 때
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return {
      statusCode: 400,
      body: JSON.stringify({
        ok: false,
        error: 'NO_IMAGE',
        message: 'imageBase64 필드가 비어 있습니다.',
        receivedKeys: Object.keys(body),
      }),
    };
  }

  // dataURL 형식이면 앞부분 제거
  const base64Data = imageBase64.includes('base64,')
    ? imageBase64.split('base64,')[1]
    : imageBase64;

  const apiKey = process.env.OCRSPACE_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: 'NO_OCR_API_KEY',
        message: '서버에 OCRSPACE_API_KEY 환경변수가 없습니다.',
      }),
    };
  }

  try {
    // PRO 전용 엔드포인트
    const resp = await fetch('https://apipro1.ocr.space/parse/image', {
      method: 'POST',
      headers: {
        apikey: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        base64Image: 'data:image/jpeg;base64,' + base64Data,
        language: 'kor,eng',
        isOverlayRequired: false,
        scale: true,
        OCREngine: 3,
      }),
    });

    if (!resp.ok) {
      const rawText = await resp.text().catch(() => '');
      return {
        statusCode: resp.status,
        body: JSON.stringify({
          ok: false,
          error: 'OCR_HTTP_ERROR',
          status: resp.status,
          raw: rawText,
        }),
      };
    }

    const data = await resp.json();

    if (!data || !data.ParsedResults || !data.ParsedResults[0]) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: false,
          error: 'EMPTY_OCR_RESULT',
          message: 'OCR 결과가 비어 있습니다.',
          raw: data,
        }),
      };
    }

    const ocrText = data.ParsedResults[0].ParsedText || '';

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        pageIndex,
        ocrText,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: 'OCR_REQUEST_FAILED',
        message: err.message || String(err),
      }),
    };
  }
};



