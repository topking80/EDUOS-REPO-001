// Staff AI providers. "local" (default) answers from templates and simple text
// analysis on the server, with no network. "openai_compatible" calls an
// external chat-completions API only when the server allows it
// (AI_ALLOW_EXTERNAL_PROVIDER=true); the text is redacted first, and any
// failure falls back to the local answer.
import { redact } from "../christie/providers.js";
import { postAiProviderJson } from "./provider-egress.js";

const words = (t) => String(t || "").trim().split(/\s+/).filter(Boolean);
const sentencesOf = (t) => String(t || "").replace(/\s+/g, " ").match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map(s => s.trim()).filter(Boolean) || [];

export const SYSTEM_PROMPTS = Object.freeze({
  lesson_draft: "You are Leo, a lesson-design assistant for K-12 teachers. Produce a clear, structured lesson plan with objectives, agenda, differentiation and assessment. Do not include or ask for any student's personal information.",
  resource_summary: "You summarize teaching resources for K-12 staff: five short bullet points, then one line on how to use it in class. Do not include personal information.",
  writing_feedback: "You are Elizabeth, a writing-feedback assistant for teachers. Give specific, kind, actionable feedback aligned to an argument-writing rubric (thesis, evidence, organization, language). Never guess who wrote it; names are removed.",
  ops_brief: "You are Edison, an operations assistant for school leaders. Given a JSON snapshot of counts, write a short brief: status, key risks, one recommended next action. Use only the numbers given.",
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
    throw new Error(`unknown use case ${usecase}`);
  },
});

export const OUTPUT_MAX_TOKENS = 900;
const utf8Bytes = (s) => Buffer.byteLength(String(s ?? ""), "utf8");
export const LOCAL_OUTPUT_MAX_BYTES = OUTPUT_MAX_TOKENS * 4;
export const localUnits = (text) => Math.max(1, Math.ceil(utf8Bytes(text) / 4));
export function capLocalOutput(text) {
  if (utf8Bytes(text) <= LOCAL_OUTPUT_MAX_BYTES) return text;
  let out = "", bytes = 3;
  for (const ch of text) { const b = utf8Bytes(ch); if (bytes + b > LOCAL_OUTPUT_MAX_BYTES) break; out += ch; bytes += b; }
  return out + "…";
}
export function validUsage(u) {
  const ok = (n) => Number.isInteger(n) && n >= 0 && n <= 100_000_000;
  return u && ok(u.prompt_tokens) && ok(u.completion_tokens) ? { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens } : null;
}
export function maxTokensFor(body) {
  return body.messages.reduce((n, m) => n + utf8Bytes(m.content) + 32, 0) + body.max_tokens;
}
export function externalRequestBody({ model, usecase, input, identifiers = {} }) {
  const content = usecase === "ops_brief" ? JSON.stringify(input.context)
    : redact(input.text, { names: identifiers.names || [], numbers: identifiers.numbers || [], max: 12000 }).slice(0, 8000);
  return { model, temperature: 0.3, max_tokens: OUTPUT_MAX_TOKENS, messages: [{ role: "system", content: SYSTEM_PROMPTS[usecase] }, { role: "user", content }] };
}

export function openAiCompatibleProvider({ url, model, apiKey, timeoutMs, allowedHosts = [], fetchImpl, log = console.warn }) {
  const endpoint = url.replace(/\/+$/, "") + "/chat/completions";
  return Object.freeze({
    name: "openai_compatible",
    async generate(usecase, input, { identifiers } = {}) {
      try {
        const body = JSON.stringify(externalRequestBody({ model, usecase, input, identifiers }));
        const headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
        let data;
        if (fetchImpl) {
          // Explicit injection is a test seam; production always uses pinned HTTPS below.
          const res = await fetchImpl(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers, body });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          data = await res.json();
        } else {
          data = await postAiProviderJson({ url, allowedHosts, headers, body, timeoutMs });
        }
        const text = String(data?.choices?.[0]?.message?.content || "").trim().slice(0, 6000);
        if (!text) throw new Error("empty reply");
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
    return openAiCompatibleProvider({ url: cfg.aiProviderUrl, model: cfg.aiProviderModel, apiKey: cfg.aiProviderApiKey, timeoutMs: cfg.aiProviderTimeoutMs, allowedHosts: cfg.aiProviderAllowedHosts });
  return { name: "local", generate: async (u, i) => ({ text: capLocalOutput(await localProvider.generate(u, i)) }) };
}
