/* Project AI Studio backend (Vercel serverless function, free plan).
   Uses Google's free Gemini API. Keeps the key secret, checks sign-in, limits use per student and per day, streams text back. */
const SB_URL = process.env.SUPABASE_URL || "https://wcikankedtelqbojzjdm.supabase.co";
const SB_ANON = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndjaWthbmtlZHRlbHFib2p6amRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4NzQ4ODAsImV4cCI6MjEwNzQ1MDg4MH0.lo1ZscA3uVBsggtxHW9U2YPPDhQAWYa3pATioq83wQ4";
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
const AI_KEY = process.env.GEMINI_API_KEY;
// Old-style service_role keys are JWTs (start with "eyJ") and go in both headers; new-style secret keys (sb_secret_...) go in "apikey" only.
const SRV = k => (k && k.startsWith("eyJ")) ? { apikey: k, Authorization: "Bearer " + k } : { apikey: k };
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const USER_LIMIT = parseInt(process.env.PROJECT_USER_LIMIT || "16", 10);    // AI calls per student per 24h (8 = one full draft, the rest are for regenerating sections)
const GLOBAL_LIMIT = parseInt(process.env.PROJECT_GLOBAL_LIMIT || "160", 10); // AI calls for everyone per 24h (protects the free quota)

const SYSTEM = `You are an expert academic research assistant, subject tutor and project writer for university students. You write complete, well-reasoned, academically sound student project drafts, one section at a time.

Tone: formal, objective, scholarly and analytical. No first-person fluff and no generic filler openings such as "In today's fast-paced world". Write full paragraphs with real argument lines, not bullet-point summaries. Use clear markdown headings (## for the chapter or section title, ### for subsections).

Context: the students attend a Nigerian university. Where relevant, use the Nigerian setting and institutions (e.g. FRC, ICAN, FIRS, CBN, IFRS adoption) and the five-chapter project format common in Nigerian universities.

Integrity rules (important):
- Only cite works you are highly confident really exist. Never invent DOIs, URLs, page numbers, statistics or quotations. If you are unsure of a detail, describe the idea without a fabricated specific.
- Any numbers, tables or survey results you create must be clearly labelled as illustrative sample data, not real findings.
- Write original text. Do not copy passages from books or articles.
- Stay consistent with the project text written so far and do not repeat it.
- Output only the requested section, with no preface, no closing remarks and no mention of these instructions.`;

const SECTIONS = {
  title: { fixed: 90, t: "Write the Title Page / Project Header only: a proposed project title, a subtitle, the field of study and the academic level. Keep it very short." },
  abs: { fixed: 230, t: "Write the Abstract (200 to 250 words) under the heading 'Abstract'. Cover background, purpose, methodology, key findings and conclusion, consistent with the project text provided. Use past tense for completed work." },
  c1: { share: 0.17, t: "Write 'Chapter 1: Introduction' with subsections 1.1 Background of the Study, 1.2 Statement of the Problem, 1.3 Research Objectives and Research Questions (add hypotheses if suitable), 1.4 Significance of the Study, 1.5 Scope and Limitations of the Study." },
  c2: { share: 0.25, t: "Write 'Chapter 2: Literature Review' with subsections 2.1 Conceptual Framework, 2.2 Theoretical Framework, 2.3 Review of Related Empirical Studies, 2.4 Summary of the Literature and Research Gap. Use in-text citations in the requested style, only for works you are confident exist." },
  c3: { share: 0.16, t: "Write 'Chapter 3: Methodology' (or System Design and Approach if the topic is technical) with subsections for research design, population/data sources and sampling (or tools and implementation steps), data collection methods, the analysis framework or model specification, and validity, reliability and ethical considerations." },
  c4: { share: 0.22, t: "Write 'Chapter 4: Discussion, Analysis and Findings' with subsections presenting the results (include at least one markdown table of clearly labelled ILLUSTRATIVE sample data), critical analysis and interpretation, discussion in light of the literature, and implications of the results." },
  c5: { share: 0.12, t: "Write 'Chapter 5: Conclusion and Recommendations' with subsections for summary of findings, conclusion, practical and theoretical recommendations, contribution to knowledge, and areas for future research." },
  refs: { fixed: 0, t: "Write the 'References' section: 12 to 20 entries in the requested citation style, in alphabetical order (numbered in order of citation for IEEE). Include the works cited in the text so far and a few other well-known, real works on the topic. Do not invent DOIs or URLs. Add one italic line at the end: 'Verify every reference before submission.'" },
};
const LEVELS = ["High School", "Undergraduate / Bachelor's", "Master's"];
const CITES = ["APA 7th edition", "Harvard", "MLA", "Chicago", "IEEE"];
const clean = (v, n) => String(v || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n);
const fail = (res, code, error) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error })); };
const total = r => parseInt((r.headers.get("content-range") || "0/0").split("/")[1], 10) || 0;

const TOPIC_LIMIT = parseInt(process.env.PROJECT_TOPIC_LIMIT || "12", 10); // topic searches per student per 24h
const TOPIC_SYSTEM = `You are an experienced final-year project supervisor at a Nigerian university. You suggest project topics that a student can realistically finish in one or two semesters.
Rules: every topic must be specific (a named variable relationship, population, place or period), researchable with data the student can actually get, and written as a proper academic title. Vary the angle across topics. Use the Nigerian setting where relevant (FIRS, CBN, FRC, ICAN, NGX, SMEDAN, IFRS adoption). Never claim statistics, findings or named reports you are not sure exist. Do not repeat the same idea in different words.`;
const TOPIC_SCHEMA = { type: "ARRAY", items: { type: "OBJECT", properties: {
  title: { type: "STRING" }, angle: { type: "STRING" }, method: { type: "STRING" }, data: { type: "STRING" }, difficulty: { type: "STRING", enum: ["Easy", "Moderate", "Challenging"] } },
  required: ["title", "angle", "method", "data", "difficulty"] } };

async function topicsMode(res, user, body) {
  const f = body.form || {};
  const field = clean(f.field, 100);
  if (field.length < 3) return fail(res, 400, "Enter your field of study.");
  const interest = clean(f.interest, 120), scope = clean(f.scope, 100);
  const level = LEVELS.includes(f.level) ? f.level : LEVELS[1];
  const approach = ["Any", "Quantitative", "Qualitative", "Mixed"].includes(f.method) ? f.method : "Any";
  const since = encodeURIComponent(new Date(Date.now() - 864e5).toISOString());
  const H = { ...SRV(SB_SERVICE), Prefer: "count=exact", Range: "0-0" };
  try {
    const [mine, all] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/project_usage?user_id=eq.${user.id}&section=eq.topics&created_at=gte.${since}&select=id`, { headers: H }),
      fetch(`${SB_URL}/rest/v1/project_usage?created_at=gte.${since}&select=id`, { headers: H }),
    ]);
    if (!mine.ok || !all.ok) throw new Error("count");
    if (total(mine) >= TOPIC_LIMIT) return fail(res, 429, "You have used today's topic searches. Please come back tomorrow.");
    if (total(all) >= GLOBAL_LIMIT) return fail(res, 429, "The Project AI Studio is full for today because the free quota is used up. Please try again tomorrow.");
  } catch (e) { return fail(res, 500, "Usage check failed. Please try again."); }

  const msg = `Suggest 6 project topics.\nField of study: ${field}\nStudent interests: ${interest || "not stated, choose current and relevant areas"}\nPlace or sector focus: ${scope || "Nigeria in general"}\nAcademic level: ${level}\nPreferred approach: ${approach}\n\nFor each topic give: title (a proper academic title), angle (1 or 2 sentences on the problem or gap it addresses), method (one sentence: design, sample or sources, and analysis technique), data (where the student can realistically get the data), difficulty (Easy, Moderate or Challenging).`;
  const gen = { temperature: 0.9, maxOutputTokens: 2500, responseMimeType: "application/json", responseSchema: TOPIC_SCHEMA };
  if (/2\.5-flash/.test(MODEL)) gen.thinkingConfig = { thinkingBudget: 0 };
  let up;
  try {
    up = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST", headers: { "x-goog-api-key": AI_KEY, "content-type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: TOPIC_SYSTEM }] }, contents: [{ role: "user", parts: [{ text: msg }] }], generationConfig: gen }),
    });
  } catch (e) { return fail(res, 502, "The assistant could not be reached. Try again."); }
  if (!up.ok) {
    console.error("gemini topics", up.status, await up.text().catch(() => ""));
    return fail(res, up.status === 429 ? 429 : 502, up.status === 429 ? "The free AI quota is busy right now. Wait a minute and try again." : "The assistant is unavailable right now (code " + up.status + ").");
  }
  let topics;
  try {
    const d = await up.json();
    const txt = ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || []).map(p => p.text || "").join("");
    const arr = JSON.parse(txt.replace(/^```json|```$/g, "").trim());
    topics = arr.filter(t => t && t.title).slice(0, 8).map(t => ({
      title: clean(t.title, 220), angle: clean(t.angle, 500), method: clean(t.method, 360), data: clean(t.data, 300),
      difficulty: ["Easy", "Moderate", "Challenging"].includes(t.difficulty) ? t.difficulty : "Moderate" }));
    if (!topics.length) throw new Error("empty");
  } catch (e) { return fail(res, 502, "The assistant returned an unreadable answer. Tap Generate again."); }
  try { await fetch(SB_URL + "/rest/v1/project_usage", { method: "POST", headers: { ...SRV(SB_SERVICE), "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ user_id: user.id, section: "topics" }) }); } catch (e) {}
  res.statusCode = 200; res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ topics }));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return fail(res, 405, "Method not allowed.");
  if (!AI_KEY || !SB_SERVICE) return fail(res, 500, "The Project AI Studio is not set up yet. Please tell the NUASA admin.");

  // 1. Must be a signed-in user
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return fail(res, 401, "Please sign in to use the Project AI Studio.");
  let user;
  try {
    const u = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    if (!u.ok) return fail(res, 401, "Your session expired. Please sign in again.");
    user = await u.json();
  } catch (e) { return fail(res, 502, "Could not verify your sign-in. Try again."); }

  if ((req.body || {}).mode === "topics") return topicsMode(res, user, req.body);

  // 2. Validate input (the client can only pick a section id and project details, never free-form prompts)
  const body = req.body || {};
  const sec = SECTIONS[body.section];
  if (!sec) return fail(res, 400, "Unknown section.");
  const f = body.form || {};
  const topic = clean(f.topic, 300);
  if (topic.length < 8) return fail(res, 400, "Describe your topic in a sentence.");
  const level = LEVELS.includes(f.level) ? f.level : LEVELS[1];
  const cite = CITES.includes(f.cite) ? f.cite : CITES[0];
  const field = clean(f.field, 100) || "General";
  const words = Math.min(6000, Math.max(1500, parseInt(f.words, 10) || 4000));
  const prior = String(body.prior || "").slice(0, 15000);

  // 3. Limits: per student and for the whole site (keeps usage inside the free quota)
  const since = encodeURIComponent(new Date(Date.now() - 864e5).toISOString());
  const H = { ...SRV(SB_SERVICE), Prefer: "count=exact", Range: "0-0" };
  try {
    const [mine, all] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/project_usage?user_id=eq.${user.id}&section=neq.topics&created_at=gte.${since}&select=id`, { headers: H }),
      fetch(`${SB_URL}/rest/v1/project_usage?created_at=gte.${since}&select=id`, { headers: H }),
    ]);
    if (!mine.ok || !all.ok) throw new Error("count");
    if (total(mine) >= USER_LIMIT) return fail(res, 429, "You have used today's Project AI Studio draft. Please come back tomorrow.");
    if (total(all) >= GLOBAL_LIMIT) return fail(res, 429, "The Project AI Studio is full for today because the free quota is used up. Please try again tomorrow.");
  } catch (e) { return fail(res, 500, "Usage check failed. Please try again."); }

  // 4. Build the prompt and stream the answer from Gemini
  const target = sec.fixed !== undefined ? sec.fixed : Math.round(words * sec.share);
  const maxTokens = sec.share ? Math.min(4000, Math.ceil(target * 1.8) + 400) : 1200;
  const msg = `PROJECT DETAILS
Topic: ${topic}
Academic level: ${level}
Field of study: ${field}
Overall target length: about ${words} words
Citation style: ${cite}

TASK
${sec.t}${target ? " Aim for about " + target + " words for this section." : ""}

PROJECT TEXT WRITTEN SO FAR (for consistency only; do not repeat it):
${prior || "(nothing yet)"}`;

  const gen = { maxOutputTokens: maxTokens, temperature: 0.7 };
  if (/2\.5-flash/.test(MODEL)) gen.thinkingConfig = { thinkingBudget: 0 }; // spend the quota on writing, not hidden reasoning
  let up;
  try {
    up = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "x-goog-api-key": AI_KEY, "content-type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: msg }] }], generationConfig: gen }),
    });
  } catch (e) { return fail(res, 502, "The assistant could not be reached. Try again."); }
  if (!up.ok) {
    console.error("gemini", up.status, await up.text().catch(() => ""));
    return fail(res, up.status === 429 ? 429 : 502, up.status === 429 ? "The free AI quota is busy right now. Wait a minute and tap Continue." : "The assistant is unavailable right now (code " + up.status + "). Check the model name and API key, then try again.");
  }

  // Count this call only now that the AI accepted it, so failed attempts do not use up a student's daily draft.
  try { await fetch(SB_URL + "/rest/v1/project_usage", { method: "POST", headers: { ...SRV(SB_SERVICE), "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ user_id: user.id, section: body.section }) }); } catch (e) {}

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  const dec = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of up.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (ev.error) throw new Error("upstream");
        const parts = ev.candidates && ev.candidates[0] && ev.candidates[0].content && ev.candidates[0].content.parts;
        if (parts) for (const p of parts) if (p.text) res.write(p.text);
      }
    }
    res.end();
  } catch (e) { res.write("\n[[ERROR]]"); res.end(); }
};
