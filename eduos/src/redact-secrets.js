// SEC-03 (docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md §4.1): secret-shaped text
// is removed before anything leaves the server for an AI provider. A teacher
// pasting a log, a config file or an email thread into the staff assistant,
// or a lesson that quotes one, could otherwise send a live credential.
//
// Removed (each as "[secret]"):
//   PEM / PGP private key blocks, JWTs, AWS access key ids, GitHub, GitLab,
//   OpenAI / Anthropic style (sk-...), Stripe, Slack, Google, Hugging Face,
//   npm and SendGrid tokens, connection strings with a password
//   (scheme://user:password@host), Bearer and Basic credentials, and the
//   value of a password / secret / key / token setting in config form
//   (`DB_PASSWORD=...`, `"apiKey": "..."`, a line starting `password: ...`).
//
// Deliberately not removed: long hex strings and other "high-entropy" text
// with no telling prefix (commit hashes, checksums and ids look the same and
// teaching content is full of them), and a word like "secret" in a sentence
// ("The secret: practise daily"). Pattern-matching can't recognise every
// secret, so staff guidance stays: don't paste credentials anywhere.
//
// Every pattern is linear (no nested quantifiers) and bounded, so hostile
// input can't make redaction slow.
export const SECRET_LABEL = "[secret]";

const KEY_WORDS = "(?:password|passwd|passphrase|pwd|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|bearer[_-]?token|token|credentials?)";
// A setting's name: the key word, optionally prefixed (DB_PASSWORD, spring.datasource.password, x-api-key).
const KEY = `[A-Za-z0-9_.-]{0,40}${KEY_WORDS}`;
const QUOTED = `(?:"[^"\\n]{1,500}"|'[^'\\n]{1,500}')`;
const VALUE = `(?:${QUOTED}|[^\\s"',;&]{1,500})`;
// With spaces around "=" it may be prose ("one token = one turn"): only a
// quoted value or an unbroken run of 8 or more characters counts.
const SPACED_VALUE = `(?:${QUOTED}|[^\\s"',;&]{8,500})`;

// Order matters: whole blocks and full tokens first, then settings, so a
// setting's value that is itself a known token is still counted as that kind.
export const SECRET_PATTERNS = Object.freeze([
  ["private_key", /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,20000}?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,4000}\.eyJ[A-Za-z0-9_-]{8,8000}\.[A-Za-z0-9_-]{8,2000}/g],
  ["connection_string", /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,200}:[^\s@/]{1,200}@[^\s"'<>]{1,500}/gi],
  ["aws_access_key", /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|ANPA|ANVA|APKA)[A-Z0-9]{16}\b/g],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g],
  ["gitlab_token", /\bglpat-[A-Za-z0-9_-]{20,255}/g],
  ["ai_provider_key", /\bsk-(?:ant-|proj-|svcacct-|admin-|or-)?[A-Za-z0-9_-]{20,255}/g],
  ["stripe_key", /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,255}\b|\bwhsec_[A-Za-z0-9]{20,255}\b/g],
  ["slack_token", /\bxox[abposr]-[A-Za-z0-9-]{10,255}|https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,300}/g],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["huggingface_token", /\bhf_[A-Za-z0-9]{30,255}\b/g],
  ["npm_token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["sendgrid_key", /\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{30,64}\b/g],
  // Authorization header values: keep the scheme so the text still reads.
  ["bearer_credential", /\b(Bearer|Basic|Token)\s+(?!\[secret\])[A-Za-z0-9._~+/=-]{16,4000}/g, "$1 " + SECRET_LABEL],
  // name=value (env files, query strings, shell): always a setting.
  ["secret_setting", new RegExp(`(\\b${KEY}["']?=)(?!\\[secret\\])${VALUE}`, "gi"), "$1" + SECRET_LABEL],
  ["secret_setting", new RegExp(`(\\b${KEY}["']?[ \\t]{1,5}=[ \\t]{0,5}|\\b${KEY}["']?=[ \\t]{1,5})(?!\\[secret\\])${SPACED_VALUE}`, "gi"), "$1" + SECRET_LABEL],
  // "name": "value" (JSON) or 'name': value.
  ["secret_setting", new RegExp(`((["'])${KEY}\\2\\s{0,5}:\\s{0,5})(?!"?\\[secret\\])${VALUE}`, "gi"), "$1" + SECRET_LABEL],
  // name: value at the start of a line (YAML, headers, a pasted form), not mid-sentence.
  ["secret_setting", new RegExp(`(^[ \\t]{0,40}(?:-[ \\t]{1,4})?${KEY}[ \\t]{0,5}:[ \\t]{0,5})(?!\\[secret\\])${VALUE}`, "gim"), "$1" + SECRET_LABEL],
]);

/** The text with every secret-shaped match replaced by "[secret]". */
export function removeSecrets(text) {
  let out = String(text ?? "");
  for (const [, re, replacement = SECRET_LABEL] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** How many of each kind removeSecrets() would remove (kinds and counts only, never values). */
export function secretKinds(text) {
  let out = String(text ?? "");
  const counts = {};
  for (const [kind, re, replacement = SECRET_LABEL] of SECRET_PATTERNS) {
    out = out.replace(re, (...m) => { counts[kind] = (counts[kind] || 0) + 1; return replacement.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? ""); });
  }
  return counts;
}
