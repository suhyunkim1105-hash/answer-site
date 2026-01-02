// netlify/functions/ocr.js
export default async (request) => {
  // CORS
  if (request.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: corsHeaders(),
    });
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST only" }, 405);
  }

  try {
    const body = await request.json();
    const image = body?.image;
    const page = Number(body?.page || 1);

    if (!image || typeof image !== "string" || !image.startsWith("data:image/")) {
      return json({ ok: false, error: "Invalid image dataURL" }, 400);
    }

    // OCR.Space expects base64Image or file
    const fd = new FormData();
    fd.append("base64Image", image);

    // minimal, stable options
    fd.append("language", "eng");
    fd.append("OCREngine", "2");
    fd.append("detectOrientation", "true");
    fd.append("scale", "true");
    fd.append("isTable", "true");
    fd.append("isOverlayRequired", "false");

    // endpoint/key are assumed to already work in your setup
    const endpoint = process.env.OCR_SPACE_API_ENDPOINT;
    const apiKey = process.env.OCR_SPACE_API_KEY;

    if (!endpoint || !apiKey) {
      return json({ ok: false, error: "OCR config missing" }, 500);
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 45000);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { apikey: apiKey },
      body: fd,
      signal: controller.signal,
    }).finally(() => clearTimeout(t));

    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      return json({ ok: false, error: `OCR HTTP ${res.status}`, raw: data }, 500);
    }

    const parsedText = extractText(data);
    const norm = normalizeOcrText(parsedText);
    const patternCount = countPatterns(norm);

    return json({
      ok: true,
      page,
      text: norm,
      patternCount,
      rawError: data?.ErrorMessage || null,
    });

  } catch (e) {
    return json({ ok: false, error: e?.name === "AbortError" ? "OCR timeout" : (e?.message || String(e)) }, 500);
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function extractText(data) {
  // OCR.Space shape
  // data.ParsedResults[0].ParsedText
  const pr = Array.isArray(data?.ParsedResults) ? data.ParsedResults : [];
  const t = pr.map(x => x?.ParsedText || "").join("\n").trim();
  return t || "";
}

function normalizeOcrText(s) {
  let t = String(s || "");

  // unify weird quotes/brackets frequently produced
  t = t
    .replace(/[‹›«»]/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'");

  // fix common OCR: O4 -> 04, O5 -> 05, etc.
  t = t.replace(/\bO(\d)\b/g, "0$1");

  // fix glued question numbers like 0505. / 0707.
  t = t.replace(/\b(0[1-9]|[1-4]\d|50)(0[1-9]|[1-4]\d|50)\./g, (m, a, b) => {
    if (a === b) return `${a} ${b}.`;
    return m;
  });

  // collapse excessive spaces but keep newlines
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

function countPatterns(t) {
  // rough: counts things that look like question numbers
  const re = /\b(0?[1-9]|[1-4]\d|50)\s*\.\s*(0?[1-9]|[1-4]\d|50)\s*\./g;
  let c = 0;
  while (re.exec(t)) c++;
  return c;
}

