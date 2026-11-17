// Staff AI providers. "local" (default) answers from templates and simple text
// analysis on the server, with no network. "openai_compatible" calls an
// external chat-completions API only when the server allows it
// (AI_ALLOW_EXTERNAL_PROVIDER=true); the text is redacted first, and any
// failure falls back to the local answer.
// Ported from EdOS app/backend/app/ai/providers.py (OfflineProvider).
import { redact } from "../christie/providers.js";

const words = (t) => String(t || "").trim().split(/\s+/).filter(Boolean);
const sentencesOf = (t) => String(t || "").replace(/\s+/g, " ").match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map(s => s.trim()).filter(Boolean) || [];

// Leo and Edison local answers (37.6).
import { leoLocalPlan } from "./leo-template.js";
import { edisonLocalBrief } from "./edison-trends.js";

export const SYSTEM_PROMPTS = Object.freeze({
  lesson_draft: "You are Leo, a lesson-design assistant for K-12 teachers. Produce a clear, structured lesson plan with objectives, agenda, differentiation and assessment. Do not include or ask for any student's personal information.",
  resource_summary: "You summarize teaching resources for K-12 staff: five short bullet points, then one line on how to use it in class. Do not include personal information.",
  writing_feedback: "You are Elizabeth, a writing-feedback assistant for teachers. Give specific, kind, actionable feedback aligned to an argument-writing rubric (thesis, evidence, organization, language). Never guess who wrote it; names are removed.",
  ops_brief: "You are Edison, an operations assistant for school leaders. Given a JSON snapshot of counts, write a short brief: status, key risks, one recommended next action. Use only the numbers given.",
  leo_lesson: "You are Leo, a lesson-design assistant for K-12 teachers. Using ONLY the standards, approved lessons and approved primary sources given, write a lesson plan: lesson flow with minutes, differentiation (support and extension) and an exit ticket. Plain text, no more than 600 words. Do not invent sources. Never refer to, grade, place or predict anything about any individual student.",
  ops_trends: "You are Edison, an operations assistant for school leaders. You are given JSON with group counts released by a privacy gate (small counts are withheld as null). Write a short brief: trends, risks, one recommended next action. Use only the numbers given; never estimate withheld counts; never discuss individual students.",
});

export const localProvider = Object.freeze({
  name: "local",
  async generate(usecase, input) {
    if (usecase === "lesson_draft") {
      const topic = String(input.text || "a new concept").trim().replace(/\.$/, "").slice(0, 200);
      return [`Lesson plan: ${topic}`, "", "Duration: 45 minutes", "", "Learning objectives:",
        `  • Explain the core idea behind ${topic} in their own words`, `  • Apply ${topic} to a guided problem`, "  • Check their work and name one next step",
        "", "Agenda:", "  1. Warm-up (5 min): quick prior-knowledge check", `  2. Mini-lesson (12 min): introduce ${topic} with one worked example`,
        "  3. Guided practice (15 min): pairs work through 3 scaffolded problems", "  4. Independent practice (8 min): exit-ticket task",
        "  5. Wrap-up (5 min): review the exit ticket, preview the next lesson", "", "Differentiation:",
        "  • Support: sentence starters and a worked-example card", "  • Stretch: an open-ended application problem", "",
        "Assessment: 3-question exit ticket scored 0-3 for mastery."].join("\n");
    }
    if (usecase === "resource_summary") {
      const s = sentencesOf(input.text);
      if (!s.length) return "Paste the resource text and I'll summarize it.";
      // Extractive: the sentences sharing the most words with the whole text.
      const freq = new Map();
      for (const w of words(input.text.toLowerCase()).filter(w => w.length > 3)) freq.set(w, (freq.get(w) || 0) + 1);
      const score = (x) => words(x.toLowerCase()).reduce((n, w) => n + (freq.get(w) || 0), 0) / Math.max(4, words(x).length);
      const top = s.map((x, i) => ({ x, i, v: score(x) })).sort((a, b) => b.v - a.v).slice(0, 5).sort((a, b) => a.i - b.i);
      return ["Summary:", ...top.map(t => `  • ${t.x}`), "", `(${words(input.text).length} words condensed to ${top.length} key sentences.)`].join("\n");
    }
    if (usecase === "writing_feedback") {
      const w = words(input.text), n = Math.max(1, sentencesOf(input.text).length), avg = Math.round((w.length / n) * 10) / 10;
      if (!w.length) return "Paste the student's writing and I'll suggest feedback.";
      return ["Writing feedback", "", `• Length: ${w.length} words across about ${n} sentences (average ${avg} words per sentence).`,
        `• Readability: ${avg > 22 ? "sentences run long; try splitting some for clarity." : "sentence length is clear and readable."}`,
        "• Structure: check that each paragraph opens with a clear topic sentence.", "", "Suggested feedback to the student:",
        "  1. Make your claim specific and arguable.", "  2. Add one piece of evidence and explain how it supports the claim.",
        "  3. Read it aloud to catch run-on sentences and tighten word choice.", "", "Rubric: thesis, evidence, organization, language."].join("\n");
    }
    if (usecase === "ops_brief") {
      const d = input.context;
      const lines = [`Operations brief (${d.scope === "district" ? `district, ${d.schools} schools` : "your school"}, ${d.day})`, ""];
      const a = d.attendance;
      lines.push(a.marked ? `• Attendance marked today: ${a.present} present, ${a.tardy} tardy, ${a.absent} absent (${Math.round((100 * (a.present + a.tardy)) / a.marked)}% in school).`
        : "• No attendance marked yet today.");
      lines.push(d.activeSafetyIncidents ? `• ${d.activeSafetyIncidents} active safety incident(s): confirm response and all-clear authority.` : "• No active safety incidents.");
      lines.push(`• Open service work: ${d.openServiceWork}.`, `• Substitute coverage still needed: ${d.coverageNeeded}.`, "");
      lines.push("Recommended next action: " + (d.activeSafetyIncidents ? "lead the safety response first, then re-assess."
        : d.coverageNeeded ? "fill open substitute coverage before first period." : a.marked && a.absent / a.marked > 0.1 ? "follow up on today's absences."
        : "monitor; nothing needs escalation."));
      return lines.join("\n");
    }
    if (usecase === "leo_lesson") return leoLocalPlan(input.leo);
    if (usecase === "ops_trends") return edisonLocalBrief(input.context);
    throw new Error(`unknown use case ${usecase}`);
  },
});

/** Most output tokens any request may produce: sent as max_tokens to an
 *  external model, and enforced on local answers by cutting them to fit. */
export const OUTPUT_MAX_TOKENS = 900;
const utf8Bytes = (s) => Buffer.byteLength(String(s ?? ""), "utf8");
/**
 * Local answers aren't tokenized or billed by anyone, so EduOS meters them in
 * its own unit: one unit per 4 UTF-8 bytes, in and out, in every language.
 * Output is cut to OUTPUT_MAX_TOKENS units (3,600 bytes; 1,200 CJK
 * characters), so a local answer can never be metered above the output cap,
 * and never above its reservation (which counts whole bytes).
 */
export const LOCAL_OUTPUT_MAX_BYTES = OUTPUT_MAX_TOKENS * 4;
export const localUnits = (text) => Math.max(1, Math.ceil(utf8Bytes(text) / 4));
export function capLocalOutput(text) {
  if (utf8Bytes(text) <= LOCAL_OUTPUT_MAX_BYTES) return text;
  let out = "", bytes = 3; // room for the ellipsis
  for (const ch of text) { const b = utf8Bytes(ch); if (bytes + b > LOCAL_OUTPUT_MAX_BYTES) break; out += ch; bytes += b; }
  return out + "…";
}

/** A provider's usage report, if it is one: two non-negative integers. */
export function validUsage(u) {
  const ok = (n) => Number.isInteger(n) && n >= 0 && n <= 100_000_000;
  return u && ok(u.prompt_tokens) && ok(u.completion_tokens) ? { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens } : null;
}
/**
 * A hard upper bound on the tokens a request can use, whatever the model's
 * tokenizer: every token is at least one byte of UTF-8, so a message can't be
 * more tokens than bytes. Bytes of the system prompt and the user content as
 * sent, plus per-message framing (64), plus the output cap. High-density
 * scripts (CJK: 3 bytes a character) are reserved for in full.
 */
export function maxTokensFor(body) {
  return body.messages.reduce((n, m) => n + utf8Bytes(m.content) + 32, 0) + body.max_tokens;
}

/** Exact request body sent to an external provider (exported for tests). */
export function externalRequestBody({ model, usecase, input, identifiers = {} }) {
  // Redact the whole text, then cut: the tutor's redact() stops at 500 characters by default.
  const content = usecase === "ops_brief" ? JSON.stringify(input.context)
    : usecase === "ops_trends" ? JSON.stringify(input.context)
    : redact(input.text, { names: identifiers.names || [], numbers: identifiers.numbers || [], max: 12000 }).slice(0, 8000);
  return { model, temperature: 0.3, max_tokens: OUTPUT_MAX_TOKENS, messages: [{ role: "system", content: SYSTEM_PROMPTS[usecase] }, { role: "user", content }] };
}

export function openAiCompatibleProvider({ url, model, apiKey, timeoutMs, fetchImpl = fetch, log = console.warn }) {
  const endpoint = url.replace(/\/+$/, "") + "/chat/completions";
  return Object.freeze({
    name: "openai_compatible",
    async generate(usecase, input, { identifiers } = {}) {
      try {
        const res = await fetchImpl(endpoint, { method: "POST", signal: AbortSignal.timeout(timeoutMs),
          headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(externalRequestBody({ model, usecase, input, identifiers })) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const text = String(data?.choices?.[0]?.message?.content || "").trim().slice(0, 6000);
        if (!text) throw new Error("empty reply");
        // usage is null when the provider didn't report it (or reported nonsense).
        return { text, usage: validUsage(data.usage) };
      } catch (e) {
        log(`ai provider unavailable (${e.message}); using the local answer`);
        return { text: capLocalOutput(await localProvider.generate(usecase, input)), fallback: true };
      }
    },
  });
}

export function createProvider(cfg) {
  if (cfg.aiProvider === "openai_compatible" && cfg.aiAllowExternal)
    return openAiCompatibleProvider({ url: cfg.aiProviderUrl, model: cfg.aiProviderModel, apiKey: cfg.aiProviderApiKey, timeoutMs: cfg.aiProviderTimeoutMs });
  return { name: "local", generate: async (u, i) => ({ text: capLocalOutput(await localProvider.generate(u, i)) }) };
}
