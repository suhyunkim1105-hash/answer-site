// netlify/functions/solve.js

exports.handler = async (event, context) => {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({
      ok: true,
      message: "solve 함수가 제대로 연결되었습니다.",
    }),
  };
};
