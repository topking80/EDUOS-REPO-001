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
//                        refuses anything else). The request carries no ids,
//                        school, grade or email, and EVERY field in it is
//                        sanitized first (outboundHelpFields): the learner's
//                        question, and also the lesson title, approved lesson,
//                        problem and hints, lose the names and numbers of any
//                        student in the district. Approved for teaching doesn't
//                        mean free of personal information. Only the sanitized
//                        copy is ever serialized; without one, nothing is sent.
//                        The local tutor keeps the original content. A reply
//                        that reveals the answer, fails or times out is
//                        replaced by the local reply.
import { bestPassage, leaksAnswer, MESSAGES } from "./tutor.js";
import { removeIdentifiers } from "../redact-names.js";
import { removeSecrets } from "../redact-secrets.js";

// SEC-03: secrets are removed before the text is cut to length, from a window
// a little past the cut (a private key block is the longest), so a secret
// straddling the cut is removed whole rather than half-sent.
const SECRET_WINDOW = 20000;

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const PHONE = /(\+?\d[\d\s().-]{7,}\d)/g;
const STUDENT_NO = /\b[A-Z]{2,5}-\d{2,}\b/g;
const LONG_DIGITS = /\b\d{6,}\b/g;

/** Remove secrets and identifiers from text before it could leave the server. */
export function redact(text, { names = [], numbers = [], max = 500 } = {}) {
  // Known students first (names in any script; student numbers as whole
  // phrases, src/redact-names.js), so the generic patterns below can't cut a
  // stored number in half before it is recognized. Then anything id-like.
  // Then the same personal details approved content loses (web addresses
  // without a scheme, street addresses, labelled birth dates), and names
  // after a title, before the broader number patterns.
  // Secrets first (src/redact-secrets.js): a connection string or token must
  // go whole, before the email and number patterns below cut it into pieces.
  const clean = removeSecrets(String(text || "").slice(0, max + SECRET_WINDOW)).slice(0, max);
  const out = removeIdentifiers(clean, { names: names.filter(Boolean), numbers });
  return out.replace(EMAIL, "[removed]").replace(URL_RE, "[removed]").replace(CONTENT_URL, "[removed]")
    .replace(CONTENT_DOB, "$1$2[removed]").replace(CONTENT_ADDRESS, "[removed]").replace(TITLED_NAME, "$1$2[name]")
    .replace(STUDENT_NO, "[removed]")
    .replace(PHONE, m => (m.replace(/\D/g, "").length >= 9 ? "[removed]" : m)).replace(LONG_DIGITS, "[removed]");
}

// A name after a title or family word ("Mrs Hargreaves", "Coach O'Neil",
// "Dr. Amara Singh", "Auntie Grace"): staff, family and other adults, whom
// the district's student index doesn't cover. Case-sensitive, so "miss the
// bus" or "my coach said" are left alone.
const TITLED_NAME = /\b(Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Coach|Principal|Nurse|Officer|Pastor|Aunt|Auntie|Uncle|Grandma|Grandpa|Nana|Papa)(\.?\s+)\p{Lu}[\p{L}\p{M}'’-]*(?:\s+\p{Lu}[\p{L}\p{M}'’-]*)?/gu;

// Personal details that can sit in teaching content, matched narrowly enough
// to leave arithmetic, fractions and historical dates alone.
const CONTENT_PHONE = /(?<![\d.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)\s?|\d{2,4}[.-])\d{3,4}[.-]\d{3,4}(?!\d|\.\d)/g;
const CONTENT_URL = /\b(?:https?:\/\/|www\.)\S+/gi;
const DATE = "(?:\\d{1,4}[\\/.-]\\d{1,2}[\\/.-]\\d{1,4}|\\d{1,2}(?:st|nd|rd|th)?\\s+\\p{L}{3,9}\\.?,?\\s+\\d{4}|\\p{L}{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})";
// A date only when it is labelled as someone's birthday.
const CONTENT_DOB = new RegExp(`\\b(d\\.?o\\.?b\\.?|date of birth|birth ?date|birthday|born(?: on)?)(\\s*(?:is|was|:|-)?\\s*)${DATE}`, "giu");
const CONTENT_ADDRESS = /\b\d{1,6}[A-Za-z]?\s+(?:[\p{L}'.-]+\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Place|Pl|Way|Terrace|Ter|Circle|Cir|Highway|Hwy)\b\.?(?:,?\s+(?:Apt|Apartment|Unit|Suite|Ste|#)\.?\s*[\w-]+)?/giu;

/**
 * Approved teaching content on its way out: secrets (src/redact-secrets.js), student names and numbers, email
 * addresses, web addresses, phone-shaped numbers, street addresses, dates
 * labelled as a birth date and names after a title ("Mr Lee") are removed. Unlike redact(), other digits are
 * left alone (a maths problem is full of them) and nothing is cut.
 * Pattern-matching can't recognize every personal detail (an unlabelled
 * birthday, an address written unusually, an untitled adult's name): lessons
 * should be written without them, and external tutoring is off by default.
 */
export function redactContent(text, identifiers = {}) {
  const out = removeIdentifiers(removeSecrets(text), { names: identifiers.names || [], numbers: identifiers.numbers || [] });
  return out.replace(EMAIL, "[removed]").replace(CONTENT_URL, "[removed]").replace(CONTENT_DOB, "$1$2[removed]")
    .replace(CONTENT_ADDRESS, "[removed]").replace(TITLED_NAME, "$1$2[name]").replace(CONTENT_PHONE, "[removed]");
}

/**
 * The sanitized copy of a help request: the only thing an external provider
 * is ever sent. `identifiers` are the district students named anywhere in
 * these fields (src/student-identifiers.js); `ownNames` the learner's and
 * signed-in user's names.
 */
export function outboundHelpFields({ question, skillTitle, explanation, prompt, unlockedHints = [] }, identifiers = {}, ownNames = []) {
  const ids = { names: [...(identifiers.names || []), ...ownNames.filter(Boolean)], numbers: identifiers.numbers || [] };
  return Object.freeze({ sanitized: true,
    question: redact(question, ids), skillTitle: redactContent(skillTitle, ids), explanation: redactContent(explanation, ids),
    prompt: redactContent(prompt, ids), unlockedHints: unlockedHints.map(h => redactContent(h, ids)) });
}

/** Every text field of a help request, for finding whom it names. */
export const helpFieldsText = ({ question, skillTitle, explanation, prompt, unlockedHints = [] }) =>
  [question, skillTitle, explanation, prompt, ...unlockedHints].filter(Boolean).join("\n");

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
      // Only a sanitized copy may leave. No copy: nothing is sent.
      if (input.outbound?.sanitized !== true) { log("christie: no sanitized request; using local reply"); return { ...(await fallback()), fallback: true }; }
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(externalRequestBody({ model, ...input.outbound })),
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
