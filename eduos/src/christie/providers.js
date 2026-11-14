// 32.4.0 Christie providers.
//
// A provider only ever answers "help" questions about the CURRENT practice
// item, using the approved lesson text and the hints the learner has already
// unlocked. Hints, feedback and refusals always come from local rules and
// approved content (src/christie/tutor.js).
//
//   local (default)      deterministic retrieval over approved content; no
//                        network calls.
//   openai_compatible    optional; only when CHRISTIE_PROVIDER=openai_compatible
//                        AND CHRISTIE_ALLOW_EXTERNAL_PROVIDER=true (config.js
//                        refuses anything else). The request carries no student
//                        identifiers: no ids, names, school, grade or email; the
//                        learner's question is redacted first. A reply that
//                        reveals the answer, fails or times out is replaced by
//                        the local reply.
import { bestPassage, leaksAnswer, MESSAGES } from "./tutor.js";

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const PHONE = /(\+?\d[\d\s().-]{7,}\d)/g;
const STUDENT_NO = /\b[A-Z]{2,5}-\d{2,}\b/g;
const LONG_DIGITS = /\b\d{6,}\b/g;

/** Remove identifiers from learner text before it could leave the server. */
export function redact(text, { names = [] } = {}) {
  let out = String(text || "").slice(0, 500);
  out = out.replace(EMAIL, "[removed]").replace(URL_RE, "[removed]").replace(STUDENT_NO, "[removed]")
    .replace(PHONE, m => (m.replace(/\D/g, "").length >= 9 ? "[removed]" : m)).replace(LONG_DIGITS, "[removed]");
  const tokens = [...new Set(names.flatMap(n => String(n || "").split(/\s+/)).filter(t => t.length >= 2))];
  for (const t of tokens) out = out.replace(new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[name]");
  return out;
}

export const localProvider = Object.freeze({
  name: "local",
  async help({ question, explanation, unlockedHints, firstHint, answer }) {
    const passage = bestPassage(question, [explanation, ...unlockedHints]);
    // 32.6.0: lesson text can contain worked examples; never quote one that gives this item's answer.
    if (passage && !leaksAnswer(passage, answer)) return { text: `${passage} What do you think the next step is?`, source: "approved_content" };
    if (firstHint) return { text: `Let's start here: ${firstHint}`, source: "approved_hint" };
    return { text: MESSAGES.offTopic, source: "rule" };
  }
});

/** Exact request body sent to an external provider (exported for tests). */
export function externalRequestBody({ model, skillTitle, explanation, prompt, unlockedHints, question }) {
  return {
    model,
    temperature: 0.2,
    max_tokens: 200,
    messages: [
      { role: "system", content: "You are Christie, a patient K-12 tutor. Use ONLY the approved lesson and hints provided. Give one short hint or guiding question. NEVER state the final answer to the problem, never solve it fully, and never ask for or mention personal information. If the question is not about the problem, say you can only help with this lesson." },
      { role: "user", content: JSON.stringify({ lesson_title: skillTitle, approved_lesson: explanation, problem: prompt, hints_already_shown: unlockedHints, learner_question: question }) }
    ]
  };
}

export function openAiCompatibleProvider({ url, model, apiKey, timeoutMs, fetchImpl = fetch, log = console.warn }) {
  const endpoint = url.replace(/\/+$/, "") + "/chat/completions";
  return Object.freeze({
    name: "openai_compatible",
    async help(input) {
      const fallback = () => localProvider.help(input);
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(externalRequestBody({ model, ...input })),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) { log(`christie provider HTTP ${res.status}; using local reply`); return { ...(await fallback()), fallback: true }; }
        const data = await res.json();
        const text = String(data?.choices?.[0]?.message?.content || "").trim().slice(0, 600);
        if (!text || leaksAnswer(text, input.answer)) return { ...(await fallback()), fallback: true };
        return { text, source: "external_provider" };
      } catch (e) {
        log(`christie provider unavailable (${e.name}); using local reply`);
        return { ...(await fallback()), fallback: true };
      }
    }
  });
}

export function createProvider(cfg) {
  if (cfg.christieProvider === "openai_compatible" && cfg.christieAllowExternal)
    return openAiCompatibleProvider({ url: cfg.christieProviderUrl, model: cfg.christieProviderModel, apiKey: cfg.christieProviderApiKey, timeoutMs: cfg.christieProviderTimeoutMs });
  return localProvider;
}
