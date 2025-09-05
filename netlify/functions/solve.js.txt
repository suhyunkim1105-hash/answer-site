exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  return {
    statusCode: 200,
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ ok: true, answer: '함수 연결 OK' })
  };
};
