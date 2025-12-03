// netlify/functions/solve.js
/* global fetch */

exports.handler = async function(event, context) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: "Method Not Allowed"
      };
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    const modelName = process.env.OPENROUTER_MODEL || "gpt-5.1";
    if (!apiKey) {
      return {
        statusCode: 500,
        body: "OPENROUTER_API_KEY not set"
      };
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return {
        statusCode: 400,
        body: "Invalid JSON body"
      };
    }

    const section     = (body.section || "reading").toLowerCase();
    const passageText = body.passageText || "";
    const screenText  = body.screenText || "";
    const audioText   = body.audioText || "";

    const systemPrompt = buildSystemPrompt(section);
    const userPrompt   = buildUserPrompt(section, passageText, screenText, audioText);

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "answer-site-toefl"
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 800
      })
    });

    if (!resp.ok) {
      const txt = await resp.text();
      return {
        statusCode: 500,
        body: "OpenRouter error: " + txt
      };
    }

    const data = await resp.json();
    const content =
      data && data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content
        ? data.choices[0].message.content
        : "";

    return {
      statusCode: 200,
      body: content
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: "solve.js error: " + e.toString()
    };
  }
};

function buildSystemPrompt(section) {
  const base =
    "You are an expert TOEFL iBT AI solver. " +
    "You must be STRICT about format and always include a confidence score line.\n" +
    "If you are not at least 10% confident in the answer, set the main answer to '?'.\n" +
    "Confidence must be a number between 0 and 1.\n";

  if (section === "reading") {
    return base +
      "Section: READING.\n" +
      "You receive:\n" +
      "- passageText: possibly the whole passage (may be empty)\n" +
      "- screenText: the question text + answer choices + part of the passage.\n" +
      "Detect the question type automatically: single-choice, multiple-answer, sentence insertion (boxes), summary, table, etc.\n" +
      "Rules:\n" +
      "1) Use passageText as the main reference when available.\n" +
      "2) For multiple choice, the final answer must be ONLY the choice numbers or BOX ids.\n" +
      "3) For sentence insertion with boxes, answer like 'BOX 2'.\n" +
      "4) ALWAYS output strictly this structure:\n" +
      "[ANSWER] <your final answer>\n" +
      "[CONFIDENCE] <0..1 number>\n" +
      "[WHY]\n" +
      "<short Korean explanation of why this is correct and why others are wrong>\n";
  }

  if (section === "listening") {
    return base +
      "Section: LISTENING.\n" +
      "You receive:\n" +
      "- audioText: a noisy ASR transcript of the conversation/lecture.\n" +
      "- screenText: the question + choices and maybe some text.\n" +
      "Use audioText as the main information source. Ignore minor ASR errors.\n" +
      "Output format:\n" +
      "[ANSWER] <choice number(s) or BOX id>\n" +
      "[CONFIDENCE] <0..1 number>\n" +
      "[WHY]\n" +
      "<short Korean explanation>.\n";
  }

  if (section === "writing") {
    return base +
      "Section: WRITING.\n" +
      "You are asked to generate the BEST possible answer in English, not to correct a student's answer.\n" +
      "Types:\n" +
      "- Integrated: you get passageText (reading) + audioText (lecture) + screenText (instructions).\n" +
      "- Independent/Discussion: only screenText with the question or discussion.\n" +
      "Do NOT exceed typical TOEFL constraints:\n" +
      "- Integrated: about 220–280 words.\n" +
      "- Independent/Discussion: about 150–220 words.\n" +
      "Output format:\n" +
      "[ESSAY]\n" +
      "<your English essay>\n" +
      "[CONFIDENCE] <0..1 number>\n";
  }

  if (section === "speaking") {
    return base +
      "Section: SPEAKING.\n" +
      "The user wants the BEST model answer in English, not feedback.\n" +
      "You may receive:\n" +
      "- passageText: reading part (for integrated tasks).\n" +
      "- audioText: lecture or conversation transcript.\n" +
      "- screenText: the question/instructions.\n" +
      "Produce an answer that fits within TOEFL speaking time limits:\n" +
      "- Task 1: about 90–110 words (~45 seconds).\n" +
      "- Tasks 2–4: about 120–150 words (~60 seconds).\n" +
      "Output format:\n" +
      "[MODEL]\n" +
      "<your English spoken-style answer>\n" +
      "[CONFIDENCE] <0..1 number>\n";
  }

  return base;
}

function buildUserPrompt(section, passageText, screenText, audioText) {
  if (section === "reading") {
    return (
      "### passageText (may be empty, possibly whole passage)\n" +
      passageText + "\n\n" +
      "### screenText (current visible screen: question + choices + partial passage)\n" +
      screenText + "\n\n" +
      "Solve this TOEFL READING question as accurately as possible.\n" +
      "Remember: if your confidence is below 0.1, output [ANSWER] ? and explain why uncertain in [WHY]."
    );
  }

  if (section === "listening") {
    return (
      "### audioText (ASR transcript of the listening material)\n" +
      audioText + "\n\n" +
      "### screenText (question + answer choices etc.)\n" +
      screenText + "\n\n" +
      "Solve this TOEFL LISTENING question.\n" +
      "If you are guessing or the transcript seems incomplete, keep confidence low (<0.1) and set [ANSWER] ?."
    );
  }

  if (section === "writing") {
    return (
      "### passageText (for integrated tasks, may be empty)\n" +
      passageText + "\n\n" +
      "### audioText (for integrated tasks, lecture transcript, may be empty)\n" +
      audioText + "\n\n" +
      "### screenText (question / instructions / prompt)\n" +
      screenText + "\n\n" +
      "Write the best possible TOEFL writing answer in English.\n" +
      "Follow the word length constraints and output in the specified format."
    );
  }

  if (section === "speaking") {
    return (
      "### passageText (may be empty)\n" +
      passageText + "\n\n" +
      "### audioText (lecture or conversation transcript, may be empty)\n" +
      audioText + "\n\n" +
      "### screenText (speaking task instructions)\n" +
      screenText + "\n\n" +
      "Generate the best possible TOEFL speaking answer in English, following the time/word constraints.\n"
    );
  }

  // fallback
  return (
    "### passageText\n" + passageText + "\n\n" +
    "### audioText\n" + audioText + "\n\n" +
    "### screenText\n" + screenText + "\n\n" +
    "Solve appropriately for TOEFL."
  );
}
