// SEC-03: secret-shaped text never reaches an AI provider. Every sample is
// assembled at runtime from harmless pieces, so this file holds no string a
// secret scanner would (rightly) flag, and nothing here is a real credential.
import test from "node:test";
import assert from "node:assert/strict";
import { removeSecrets, secretKinds, SECRET_LABEL } from "../src/redact-secrets.js";
import { redact, redactContent, outboundHelpFields } from "../src/christie/providers.js";
import { externalRequestBody } from "../src/ai/providers.js";

const r = (s, n) => s.repeat(n);
const alnum = n => r("aB3", Math.ceil(n / 3)).slice(0, n);
const dashes = r("-", 5);
const pem = (label, body, closed) => `${dashes}BEGIN ${label}${dashes}\n${body}` + (closed ? `\n${dashes}END ${label}${dashes}` : "");
const SAMPLES = {
  private_key: pem("RSA PRIVATE KEY", r("MIIEow", 20), true),
  pgp_private_key: pem("PGP PRIVATE KEY BLOCK", r("lQOYBF", 10), true),
  truncated_private_key: pem("OPENSSH PRIVATE KEY", r("b3BlbnNzaC1rZXk", 8), false),
  jwt: ["ey" + "J" + alnum(20), "ey" + "J" + alnum(40), alnum(43)].join("."),
  connection_string: "postgres" + "://eduos_app:" + "Sup3r-" + "pass" + "@db.internal:5432/eduos",
  aws_access_key: "AK" + "IA" + r("Q", 16),
  github_token: "gh" + "p_" + alnum(36),
  github_fine_grained: "github" + "_pat_" + alnum(82),
  gitlab_token: "gl" + "pat-" + alnum(20),
  openai_key: "sk" + "-proj-" + alnum(48),
  anthropic_key: "sk" + "-ant-api03-" + alnum(40),
  stripe_key: "sk" + "_live_" + alnum(24),
  stripe_webhook: "wh" + "sec_" + alnum(32),
  slack_token: "xo" + "xb-" + "1234567890-" + alnum(24),
  slack_webhook: "https://hooks." + "slack.com/services/T000/B000/" + alnum(24),
  google_api_key: "AI" + "za" + alnum(35),
  huggingface_token: "h" + "f_" + alnum(34),
  npm_token: "np" + "m_" + alnum(36),
  sendgrid_key: "S" + "G." + alnum(22) + "." + alnum(43),
};
const SETTINGS = [
  ["DB_PASSWORD=" + "hunter" + "2", "DB_PASSWORD=" + SECRET_LABEL],
  ["export API_KEY='" + alnum(12) + "'", "export API_KEY=" + SECRET_LABEL],
  ['{"client_secret": "' + alnum(16) + '", "name": "Room 4"}', '{"client_secret": ' + SECRET_LABEL + ', "name": "Room 4"}'],
  ["spring.datasource.password = " + alnum(10), "spring.datasource.password = " + SECRET_LABEL],
  ["smtp:\n  password: " + alnum(10) + "\n  host: mail", "smtp:\n  password: " + SECRET_LABEL + "\n  host: mail"],
  ["Password: " + alnum(9), "Password: " + SECRET_LABEL],
  ["https://api.example/v1?access_token=" + alnum(20) + "&page=2", "https://api.example/v1?access_token=" + SECRET_LABEL + "&page=2"],
  ["Authorization: Bearer " + alnum(40), "Authorization: Bearer " + SECRET_LABEL],
];

test("every kind of secret is removed whole", () => {
  for (const [kind, secret] of Object.entries(SAMPLES)) {
    const out = removeSecrets(`before ${secret} after`);
    assert.ok(!out.includes(secret.slice(-12)), `${kind}: removed`);
    assert.match(out, /^before \[secret\]/, `${kind}: replaced in place`);
    if (!kind.startsWith("truncated")) assert.match(out, / after$/, `${kind}: nothing after it is lost`);
  }
});

test("a secret setting keeps its name and loses its value", () => {
  for (const [input, expected] of SETTINGS) assert.equal(removeSecrets(input), expected);
});

test("ordinary teaching and school text is left alone", () => {
  for (const text of [
    "The secret: practise a little every day.",
    "Use a strong password for your account; never share it.",
    "Each player gets one token = one turn on the board.",
    "Commit 3f9a2c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39 fixed the bus report.",
    "Student id 12345678 and room 204; 3/4 + 1/8 = 7/8.",
    "Visit https://www.example.org/lesson and ask Mr Lee.",
    "max_tokens=900 is the model setting.",
    "Basic multiplication facts and Bearer bonds in history class.",
    "task-force sk-and skating: the sk- prefix alone is fine.",
  ]) assert.equal(removeSecrets(text), text);
});

test("kinds and counts are reported without values", () => {
  const text = `${SAMPLES.github_token} and ${SAMPLES.jwt} and DB_PASSWORD=x9 and ${SAMPLES.github_token}`;
  const kinds = secretKinds(text);
  assert.deepEqual(kinds, { jwt: 1, github_token: 2, secret_setting: 1 });
  assert.ok(!JSON.stringify(kinds).includes(SAMPLES.github_token));
});

test("hostile input can't make redaction slow", () => {
  for (const t of [r("a", 300000), r("_.-", 100000), r("eyJ", 100000), "Bearer " + r("a", 200000), r("password" + r("_", 39), 5000), pem("PRIVATE KEY", r("A", 300000), false)]) {
    const start = process.hrtime.bigint();
    removeSecrets(t);
    assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 500, `${t.slice(0, 12)}… took too long`);
  }
});

test("the staff assistant's external request carries no secret", () => {
  const pasted = `Fix this config:\nDATABASE_URL=${SAMPLES.connection_string}\nkey ${SAMPLES.openai_key}\n${SAMPLES.private_key}\nThanks, ava@school.example`;
  for (const usecase of ["resource_summary", "writing_feedback", "lesson_draft", "leo_lesson"]) {
    const body = JSON.stringify(externalRequestBody({ model: "m", usecase, input: { text: pasted } }));
    for (const s of [SAMPLES.connection_string, SAMPLES.openai_key, "MIIEow", "Sup3r-", "ava@school.example"]) assert.ok(!body.includes(s), `${usecase}: ${s.slice(0, 10)}…`);
    assert.match(body, /\[secret\]/);
  }
});

test("a secret straddling the length cut isn't half-sent", () => {
  const filler = r("word ", 99) + "abc";      // 498 characters
  const out = redact(filler + " " + SAMPLES.github_token, { max: 510 });
  assert.ok(!out.includes(SAMPLES.github_token.slice(0, 10)), "no fragment of the token");
});

test("Christie's outbound fields lose secrets in the learner's question and in approved content", () => {
  const f = outboundHelpFields({ question: `my brother's key is ${SAMPLES.aws_access_key}`, skillTitle: "Fractions",
    explanation: `Example config: password=${alnum(8)}`, prompt: `token ${SAMPLES.slack_token}`, unlockedHints: [`See ${SAMPLES.jwt}`] }, {}, []);
  const all = JSON.stringify(f);
  for (const s of [SAMPLES.aws_access_key, SAMPLES.slack_token, SAMPLES.jwt]) assert.ok(!all.includes(s));
  assert.equal(f.skillTitle, "Fractions");
  assert.equal(redactContent("3/4 + 1/8 = 7/8"), "3/4 + 1/8 = 7/8", "maths survives");
});
