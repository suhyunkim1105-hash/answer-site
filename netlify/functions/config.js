// netlify/functions/config.js
export const handler = async () => {
  // STOP_TOKEN은 공개되어도 괜찮은 값(문제지에 없을 임의 문자열)
  const stopToken = process.env.STOP_TOKEN || "ABCDEFGH";
  return {
    statusCode: 200,
    body: JSON.stringify({ stopToken }),
  };
};
