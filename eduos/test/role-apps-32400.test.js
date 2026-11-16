// EduOS 32.4.0 mobile role apps: Christie tutor rules and identifier
// stripping, the provider gate, notification outbox rules, and the
// migration / grant / policy / PWA contracts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isCorrect, classifyQuestion, itemScore, nextMastery, bestPassage, leaksAnswer, MASTERED_AT } from "../src/christie/tutor.js";
import { redact, externalRequestBody, localProvider, openAiCompatibleProvider, createProvider, outboundHelpFields } from "../src/christie/providers.js";
import { ROLE_PERMISSIONS, canPerform as canActor } from "../src/policy.js";
const canPerform = (role, res, act) => canActor({ role, districtId: "d", userId: "u" }, res, act);

const ENV = { DATABASE_URL: "postgres://eduos:test@127.0.0.1:1/eduos", PUBLIC_ORIGIN: "http://localhost:8080", OIDC_ISSUER: "https://idp.example.test",
  OIDC_CLIENT_ID: "eduos-test", OIDC_CLIENT_SECRET: "test-secret", OIDC_REDIRECT_URI: "http://localhost:8080/auth/callback" };
for (const [k, v] of Object.entries(ENV)) process.env[k] ||= v;
const { outboxRows, enabledExternalChannels, adapterFor, EXTERNAL_TEXT, attemptOutcome, retryDelaySeconds, MAX_ATTEMPTS } = await import("../src/notify.js");
const read = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const cfgOff = { notifyEmailAdapter: "off", notifySmsAdapter: "off", notifyPushAdapter: "off" };

test("Christie checks answers forgivingly: numbers, fractions, x=5, case and spacing", () => {
  assert.ok(isCorrect("12", "12")); assert.ok(isCorrect(" 12. ", "12"));
  assert.ok(isCorrect("2/4", "1/2")); assert.ok(isCorrect("0.5", "1/2"));
  assert.ok(isCorrect("x = 5", "5")); assert.ok(isCorrect("The", "the"));
  assert.ok(!isCorrect("", "5")); assert.ok(!isCorrect("6", "5")); assert.ok(!isCorrect("1/0", "0"));
});

test("Christie classifies questions: refuses answer requests, routes safety words to an adult", () => {
  assert.equal(classifyQuestion("just tell me the answer"), "answer_request");
  assert.equal(classifyQuestion("what's the answer?"), "answer_request");
  assert.equal(classifyQuestion("someone is hurting me"), "needs_adult");
  assert.equal(classifyQuestion("can I talk to my teacher"), "needs_adult");
  assert.equal(classifyQuestion("how do I find the denominator?"), "help");
});

test("mastery is a simple moving estimate, bounded 0-100", () => {
  assert.equal(itemScore({ correct: true, hintLevel: 0, wrongAttempts: 0 }), 1);
  assert.equal(itemScore({ correct: true, hintLevel: 1, wrongAttempts: 0 }), 0.6);
  assert.equal(itemScore({ correct: false, hintLevel: 0, wrongAttempts: 0 }), 0);
  let m = 0; for (let i = 0; i < 6; i++) m = nextMastery(m, 1);
  assert.ok(m >= MASTERED_AT && m <= 100);
  assert.equal(nextMastery(150, 1), 100); assert.equal(nextMastery(-5, 0), 0);
});

test("local provider only quotes approved lesson text and unlocked hints", async () => {
  const explanation = "Multiply the top and bottom by the same number. The amount stays the same.";
  assert.equal(bestPassage("why multiply the bottom?", [explanation]), "Multiply the top and bottom by the same number.");
  const r = await localProvider.help({ question: "zzz", explanation, unlockedHints: [], firstHint: "Look at the bottom number." });
  assert.equal(r.source, "approved_hint");
  assert.ok(leaksAnswer("The answer is 12", "12")); assert.ok(leaksAnswer("3x4 = 12", "12"));
  assert.ok(!leaksAnswer("Try adding 4 three times", "12"));
});

test("identifiers are stripped before anything could leave the server", () => {
  const out = redact("I'm Ava Morgan (ava@school.example, RES-1001, 555-123-4567, id 12345678) see https://x.example/a", { names: ["Ava Morgan", "Alex Morgan"] });
  for (const bad of ["Ava", "Morgan", "ava@school.example", "RES-1001", "555-123-4567", "12345678", "https://"]) assert.ok(!out.includes(bad), `${bad} in ${out}`);
  const body = externalRequestBody({ model: "m", skillTitle: "Fractions", explanation: "e", prompt: "1/2 = ?/4", unlockedHints: ["h"], question: out,
    answer: "2", studentId: "00000000-0000-4000-8000-000000000301", studentName: "Ava Morgan", email: "ava@school.example", schoolId: "s", grade: "4" });
  const s = JSON.stringify(body);
  for (const bad of ["answer\":", "00000000-0000", "Ava", "school.example", "grade", "school_id"]) assert.ok(!s.includes(bad), bad);
});

test("external provider is off by default, gated by env, and falls back locally on leaks or errors", async () => {
  assert.equal(createProvider({ christieProvider: "local" }).name, "local");
  assert.equal(createProvider({ christieProvider: "openai_compatible", christieAllowExternal: false }).name, "local");
  const sent = [];
  const leaky = openAiCompatibleProvider({ url: "https://llm.example/v1", model: "m", timeoutMs: 1000, log: () => {},
    fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ choices: [{ message: { content: "The answer is 2" } }] }) }; } });
  const ask = { question: "help", explanation: "Multiply.", unlockedHints: [], firstHint: "Look at 2 and 4.", prompt: "1/2=?/4", skillTitle: "F", answer: "2" };
  // Without a sanitized copy of the request, nothing is sent at all.
  assert.equal((await leaky.help(ask)).fallback, true);
  assert.equal(sent.length, 0);
  const r = await leaky.help({ ...ask, outbound: outboundHelpFields(ask) });
  assert.equal(r.fallback, true); assert.ok(!/answer is 2/.test(r.text));
  assert.equal(sent[0].url, "https://llm.example/v1/chat/completions");
  assert.ok(!JSON.stringify(sent[0].body).includes("\"answer\""));
  const down = openAiCompatibleProvider({ url: "https://llm.example", model: "m", timeoutMs: 1000, log: () => {}, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal((await down.help({ question: "q", explanation: "e", unlockedHints: [], firstHint: "h", answer: "2" })).fallback, true);
  const boot = env => spawnSync(process.execPath, ["-e", "import('./src/config.js').then(()=>console.log('ok'))"], { env: { PATH: process.env.PATH, ...ENV, ...env }, encoding: "utf8" });
  assert.match(boot({ CHRISTIE_PROVIDER: "openai_compatible", CHRISTIE_PROVIDER_URL: "https://llm.example", CHRISTIE_PROVIDER_MODEL: "m" }).stderr, /CHRISTIE_ALLOW_EXTERNAL_PROVIDER/);
  assert.match(boot({ CHRISTIE_PROVIDER: "openai_compatible", CHRISTIE_ALLOW_EXTERNAL_PROVIDER: "true", CHRISTIE_PROVIDER_URL: "http://llm.example", CHRISTIE_PROVIDER_MODEL: "m" }).stderr, /https/i);
  assert.match(boot({ NOTIFY_SMS_ADAPTER: "twilio" }).stderr, /NOTIFY_SMS_ADAPTER/);
  assert.equal(boot({}).stdout.trim(), "ok");
});

test("notifications: in-app only by default; external rows carry generic text only; adapters never send", async () => {
  const rows = outboxRows({ districtId: "d", recipients: ["u1", "u1", "u2", null], kind: "transport", title: "Ava boarded Bus 7 at Maple Ave", refType: "transport_checkin", refId: "x" }, cfgOff);
  assert.deepEqual(rows.map(r => [r.recipient, r.channel, r.status]), [["u1", "in_app", "delivered"], ["u2", "in_app", "delivered"]]);
  assert.deepEqual(enabledExternalChannels(cfgOff), []);
  const on = { notifyEmailAdapter: "log", notifySmsAdapter: "log", notifyPushAdapter: "off" };
  const ext = outboxRows({ districtId: "d", recipients: ["u1"], kind: "message", title: "About Ava: reading log", body: "private" }, on).filter(r => r.channel !== "in_app");
  assert.deepEqual(ext.map(r => r.channel), ["email", "sms"]);
  // Reference ids stay on the row (for delivery reports); the adapter never gets them.
  for (const r of ext) { assert.equal(r.title, EXTERNAL_TEXT); assert.equal(r.body, null); }
  const logged = [];
  const res = await adapterFor("email", on).send({ id: "n1", channel: "email", recipient_user_id: "u1", title: "secret" }, m => logged.push(m));
  assert.equal(res.status, "skipped"); assert.ok(!logged.join().includes("secret"));
  assert.equal((await adapterFor("push", on).send({})).status, "skipped");
  assert.throws(() => outboxRows({ districtId: "d", recipients: ["u"], kind: "marketing", title: "x" }, cfgOff));
});

test("notification attempts: only a confirmed delivery counts; failures back off and then stop", () => {
  assert.deepEqual(attemptOutcome({ status: "delivered" }, 0), { status: "delivered", note: null, attempts: 1, retryInSeconds: null });
  assert.equal(attemptOutcome({ status: "skipped", note: "dry run" }, 0).status, "skipped");
  const retry = attemptOutcome({ status: "pending", note: "smtp 451" }, 0);
  assert.deepEqual([retry.status, retry.retryInSeconds], ["pending", 30]);
  assert.equal(attemptOutcome({ status: "pending" }, 2).retryInSeconds, 120);
  assert.equal(retryDelaySeconds(30), 3600, "at most an hour");
  const last = attemptOutcome({ status: "pending", note: "smtp 451" }, MAX_ATTEMPTS - 1);
  assert.equal(last.status, "failed"); assert.match(last.note, /gave up after 5 attempts: smtp 451/);
  for (const bad of [undefined, null, {}, { status: "sent" }, { status: "DELIVERED" }]) {
    const o = attemptOutcome(bad, 0);
    assert.equal(o.status, "failed", JSON.stringify(bad)); assert.match(o.note, /unknown status/);
  }
});

test("policy: driver role is narrow; pupils tutor and read but cannot message", () => {
  const driver = ROLE_PERMISSIONS.driver;
  // 32.5.0 adds safety:read (the full-screen SafetyOS state on the bus app).
  assert.deepEqual(Object.keys(driver).sort(), ["branding", "comms", "flow_events", "safety", "schools", "transport"]);
  assert.deepEqual(driver.safety, ["read"]);
  assert.ok(canPerform("driver", "transport", "checkin")); assert.ok(!canPerform("driver", "transport", "manage"));
  for (const r of ["parent", "teacher", "pupil"]) assert.ok(!canPerform(r, "transport", "checkin"), r);
  assert.ok(canPerform("pupil", "christie", "tutor")); assert.ok(!canPerform("pupil", "comms", "message"));
  assert.ok(!canPerform("parent", "christie", "review")); assert.ok(!canPerform("teacher", "christie", "approve"));
  assert.ok(canPerform("principal", "comms", "moderate")); assert.ok(!canPerform("teacher", "comms", "moderate"));
  assert.ok(!canPerform("it_admin", "transport", "read"), "IT admin has no student transport data");
});

test("migration 012: RLS on every new table, append-only history, no location columns, purge coverage", () => {
  const sql = read("db/012_role_apps_transport_christie_comms.sql");
  const tables = [...sql.matchAll(/CREATE TABLE (\w+)/g)].map(m => m[1]);
  assert.ok(tables.length >= 18);
  for (const t of tables) assert.ok(new RegExp(`'${t}'`).test(sql.split("FORCE ROW LEVEL SECURITY")[0].slice(-3000)) || sql.includes(`'${t}'`), `${t} in RLS loop`);
  assert.match(sql, /transport_checkins_append_only|christie_turns_append_only/);
  const ddl = sql.replace(/--.*$/gm, "");
  assert.ok(!/\b(latitude|longitude|lat|lng|geography|geometry|gps|coords)\b/i.test(ddl), "no location columns");
  for (const t of ["transport_checkins", "christie_turns", "christie_sessions", "student_skill_mastery", "transport_rider_assignments", "comms_threads"])
    assert.match(sql.slice(sql.indexOf("eduos_purge_student")), new RegExp(t), `purge covers ${t}`);
  const grants = read("db/runtime_grants.template.sql");
  assert.match(grants, /GRANT SELECT, INSERT ON .*transport_checkins/);
  assert.ok(!/GRANT[^;]*UPDATE[^;(]*ON[^;]*transport_checkins/.test(grants), "check-ins are never updatable");
  assert.ok(!/GRANT[^;]*DELETE[^;]*(comms_|christie_|transport_|notification_outbox)/.test(grants), "no deletes on new tables");
  assert.ok(read("src/migrate.js").includes("012_role_apps_transport_christie_comms.sql"));
});

test("mobile app shell: installable PWA, no inline script, shell-only service worker", () => {
  const html = read("public/app/index.html");
  assert.match(html, /<link rel="manifest"/); assert.match(html, /name="theme-color"/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "no inline scripts");
  assert.ok(!/\son[a-z]+=/.test(html), "no inline handlers");
  const sw = read("public/app/sw.js");
  assert.match(sw, /\/api\//); assert.ok(!/cache\.put\([^)]*api/i.test(sw));
  const manifest = JSON.parse(read("public/app/manifest.webmanifest"));
  assert.equal(manifest.display, "standalone"); assert.equal(manifest.start_url, "/app/"); assert.equal(manifest.scope, "/app/");
  assert.ok(existsSync(new URL("../public/app/app.js", import.meta.url)));
  const js = read("public/app/app.js");
  assert.ok(!/navigator\.geolocation/.test(js), "the app never asks for location");
  assert.ok(!/innerHTML\s*=\s*`[^`]*\$\{/.test(js), "no template-literal innerHTML with data");
});
