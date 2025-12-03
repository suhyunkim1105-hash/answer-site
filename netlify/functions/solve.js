/* netlify/functions/solve.js */

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
    "Always follow TOEFL format and constraints, and ALWAYS include a confidence line.\n" +
    "If you are not at least 10% confident in the final answer, set the main answer to '?'.\n" +
    "The [CONFIDENCE] value must be a single number between 0 and 1 (e.g. 0.27).\n";

  // ---------- READING ----------
  if (section === "reading") {
    return (
      base +
      "SECTION: READING.\n" +
      "You receive:\n" +
      "- passageText: possibly the whole reading passage (may be empty).\n" +
      "- screenText: the CURRENT VISIBLE SCREEN (question + answer choices + maybe part of the passage).\n" +
      "\n" +
      "TOEFL reading question types you must handle:\n" +
      "- Single-answer multiple choice (most common, 4 options, sometimes 5).\n" +
      "- Multiple-answer questions (e.g., choose 2 answers).\n" +
      "- Sentence insertion questions with boxes in the passage.\n" +
      "- Summary questions (choose 3 of 6 options).\n" +
      "- Table/Category questions (distribute options into columns/rows).\n" +
      "\n" +
      "INFER THE QUESTION TYPE from screenText.\n" +
      "Use passageText as the MAIN reference if it exists, and screenText for the exact wording and options.\n" +
      "\n" +
      "When you output the main answer, you MUST:\n" +
      "- Use ONLY labels that actually appear in the answer choices in screenText (numbers like 1–4/5, or letters, or BOX ids).\n" +
      "- For sentence insertion, answer like 'BOX 2' or 'BOX 3' (one BOX only).\n" +
      "- For multiple-answer questions, output a comma-separated list of labels with NO extra words (e.g., '2,4,5').\n" +
      "- For summary questions (choose 3 of 6), output exactly 3 labels.\n" +
      "- For table questions, group labels under each column.\n" +
      "\n" +
      "If the OCR text is clearly incomplete, badly broken, or does not contain enough information to solve the question,\n" +
      "keep your confidence very low (<0.1) and set [ANSWER] ?.\n" +
      "\n" +
      "OUTPUT FORMAT (STRICT):\n" +
      "[ANSWER] <final answer using ONLY valid labels or '?'>\n" +
      "[CONFIDENCE] <0..1 number>\n" +
      "[WHY]\n" +
      "- Very short Korean explanation of why this answer is most likely correct.\n" +
      "- Briefly mention why other choices are probably wrong (in Korean).\n"
    );
  }

  // ---------- LISTENING ----------
  if (section === "listening") {
    return (
      base +
      "SECTION: LISTENING.\n" +
      "You receive:\n" +
      "- audioText: an ASR transcript (possibly noisy) of a TOEFL listening conversation/lecture.\n" +
      "- screenText: the question and answer choices (current screen).\n" +
      "\n" +
      "Assume the user only heard the audio ONCE, so audioText is precious. Do NOT invent details that are clearly not in audioText.\n" +
      "If the transcript is obviously too short, heavily corrupted, or missing key parts, keep confidence <0.1 and set [ANSWER] ?.\n" +
      "\n" +
      "Handle the same multiple-choice patterns as reading (single, multiple-answer, summary/table style if ever present).\n" +
      "Use audioText as the main source of truth; use screenText to detect the question type and option labels.\n" +
      "\n" +
      "OUTPUT FORMAT (STRICT):\n" +
      "[ANSWER] <choice label(s) or '?'>\n" +
      "[CONFIDENCE] <0..1 number>\n" +
      "[WHY]\n" +
      "- Short Korean explanation using the key points from the listening transcript.\n"
    );
  }

  // ---------- WRITING ----------
  if (section === "writing") {
    return (
      base +
      "SECTION: WRITING.\n" +
      "You generate the BEST possible TOEFL writing answer in ENGLISH (not feedback on a student's answer).\n" +
      "Inputs:\n" +
      "- passageText: reading passage (for integrated tasks, may be empty for independent tasks).\n" +
      "- audioText: lecture transcript (for integrated tasks, may be empty for independent tasks).\n" +
      "- screenText: the task instructions (including whether it is integrated vs independent/discussion).\n" +
      "\n" +
      "Integrated Writing (reading + listening):\n" +
      "- Summarize the main points of the lecture and explain how they relate to (usually contradict or challenge) the reading.\n" +
      "- Do NOT add your own opinion.\n" +
      "- Use clear structure: brief introduction, 2–3 body paragraphs grouping key points, short conclusion.\n" +
      "- Typical target length: about 220–280 words.\n" +
      "\n" +
      "Independent / Academic Discussion Writing:\n" +
      "- Respond directly to the prompt; clearly state your opinion or position.\n" +
      "- Use 2–3 main reasons with simple but concrete examples.\n" +
      "- Keep language natural and clear, not like a research paper.\n" +
      "- Typical target length: about 150–220 words.\n" +
      "\n" +
      "GENERAL RULES:\n" +
      "- Respect the length ranges above; do NOT produce extremely long essays.\n" +
      "- Use vocabulary appropriate for a high-scoring TOEFL candidate (not graduate-level journal style).\n" +
      "- Do not copy long chunks verbatim; paraphrase naturally.\n" +
      "\n" +
      "OUTPUT FORMAT (STRICT):\n" +
      "[ESSAY]\n" +
      "<your English essay>\n" +
      "[CONFIDENCE] <0..1 number>\n"
    );
  }

  // ---------- SPEAKING ----------
  if (section === "speaking") {
    return (
      base +
      "SECTION: SPEAKING.\n" +
      "The user wants the BEST model answer in English for TOEFL speaking tasks (not feedback on their own answer).\n" +
      "Inputs:\n" +
      "- passageText: reading part (for integrated speaking tasks, may be empty).\n" +
      "- audioText: lecture or conversation transcript (for integrated tasks, may be empty).\n" +
      "- screenText: the speaking task instructions.\n" +
      "\n" +
      "STRUCTURE:\n" +
      "- Start with 1 clear sentence that directly answers the question.\n" +
      "- Then give 2 main reasons or points, each with a brief concrete example or detail.\n" +
      "- End with 1 short wrap-up sentence.\n" +
      "For integrated tasks, clearly use both the reading and listening information; do NOT add your own opinion.\n" +
      "\n" +
      "LENGTH (match TOEFL timing):\n" +
      "- Task 1: about 90–110 words (~45 seconds when spoken).\n" +
      "- Tasks 2–4: about 120–150 words (~60 seconds when spoken).\n" +
      "\n" +
      "VOCABULARY RULES:\n" +
      "- Use natural, high-scoring TOEFL speaking vocabulary (around B2–C1 level).\n" +
      "- Avoid very technical, graduate-level, or research-journal style words unless absolutely necessary.\n" +
      "- If you use a word that would likely be difficult for a typical Korean TOEFL undergraduate student,\n" +
      "  immediately add a Korean pronunciation hint in Hangul right after the word in parentheses.\n" +
      "  Example: sustainable(서스테이너블), efficient(이피션트).\n" +
      "- In the parentheses, write ONLY pronunciation (no Korean meanings), and limit these hints to at least 1 and at most 5 words.\n" +
      "\n" +
      "STYLE:\n" +
      "- Sound like a natural spoken answer: use contractions (I'm, don't, it's, etc.), simple clear sentences, and logical flow.\n" +
      "\n" +
      "OUTPUT FORMAT (STRICT):\n" +
      "[MODEL]\n" +
      "<your English spoken-style answer, including pronunciation hints as needed>\n" +
      "[CONFIDENCE] <0..1 number>\n"
    );
  }

  // ---------- FALLBACK ----------
  return (
    base +
    "Unknown section; behave like a general TOEFL helper.\n" +
    "Still respect the [ANSWER]/[ESSAY]/[MODEL] + [CONFIDENCE] format depending on the context.\n"
  );
}

function buildUserPrompt(section, passageText, screenText, audioText) {
  if (section === "reading") {
    return (
      "### passageText (may be empty, possibly whole passage)\n" +
      passageText + "\n\n" +
      "### screenText (current visible screen: question + choices + partial passage)\n" +
      screenText + "\n\n" +
      "Solve this TOEFL READING question as accurately as possible.\n" +
      "Remember: if your confidence is below 0.1, output [ANSWER] ? and explain briefly in [WHY] why you are uncertain."
    );
  }

  if (section === "listening") {
    return (
      "### audioText (ASR transcript of the listening material)\n" +
      audioText + "\n\n" +
      "### screenText (question + answer choices etc.)\n" +
      screenText + "\n\n" +
      "Solve this TOEFL LISTENING question.\n" +
      "If the transcript is incomplete or unclear, keep [CONFIDENCE] low and set [ANSWER] ?."
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
      "Follow the length and structure constraints described in the system message, and output in the specified format."
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
      "Generate the best possible TOEFL speaking answer in English, following the time/word and vocabulary constraints.\n"
    );
  }

  return (
    "### passageText\n" + passageText + "\n\n" +
    "### audioText\n" + audioText + "\n\n" +
    "### screenText\n" + screenText + "\n\n" +
    "Solve appropriately for TOEFL, and still respect the required output format."
  );
}
