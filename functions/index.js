const { onRequest } = require("firebase-functions/v2/https");
const cors = require("cors")({ origin: true });
const fetch = require("node-fetch");

exports.solve = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const { question } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Missing question" });
    }

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({ error: "Missing OPENROUTER_API_KEY env" });
    }

    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [
          { role: "system", content: "Return only the final answer, concise." },
          { role: "user", content: question }
        ],
        temperature: 0.2
      })
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      return res.status(502).json({ error: "Upstream error", detail });
    }

    const data = await upstream.json();
    const answer = (data?.choices?.[0]?.message?.content || "").trim();
    return res.json({ answer });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});
