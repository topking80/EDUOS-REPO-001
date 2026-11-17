// The staff assistant with an external AI provider, against real PostgreSQL
// and a fake provider that records exactly what it receives (audit: P0
// privacy, P1 budget integrity):
// - a superintendent's text loses every student name and number in the
//   district before it leaves, however big the district (no 5,000 cap);
// - long text isn't cut to 500 characters;
// - 20 simultaneous requests against a nearly spent budget stay within it.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

const INTERNATIONAL = { 1: "Мария Иванова", 2: "李小龍", 3: "山田 花子", 4: "김민준", 5: "محمد علي", 6: "Jose\u0301 Núñez", 7: "Siobhán O\u2019Brien", 8: "Q Z", 9: "आरव शर्मा" };

function fakeProvider() {
  const received = [];
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => {
      const json = JSON.parse(body); received.push(json);
      const said = json.messages[1].content;
      if (said.includes("HANG-FOREVER")) return; // never answers
      const usage = said.includes("INFLATE-USAGE") ? { prompt_tokens: 999999, completion_tokens: 1 }
        : said.includes("NO-USAGE") ? undefined : said.includes("BAD-USAGE") ? { prompt_tokens: -5, completion_tokens: "lots" } : { prompt_tokens: 50, completion_tokens: 900 };
      setTimeout(() => { res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "OK from the model" } }], usage })); }, 150);
    });
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}/v1`, received, close: () => new Promise(x => srv.close(x)) })));
}

describe("staff assistant with an external provider against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, provider, s = {};
  const as = name => client(server.base, s[name]);
  const runAi = (name, usecase, text) => as(name)("POST", "/api/ai/run", { usecase, text });
  const sentText = () => provider.received.at(-1).messages[1].content;

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    provider = await fakeProvider();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, AI_PROVIDER: "openai_compatible", AI_ALLOW_EXTERNAL_PROVIDER: "true",
      AI_PROVIDER_URL: provider.url, AI_PROVIDER_MODEL: "fake-model", AI_ALLOW_INSECURE_LOOPBACK: "true", AI_PROVIDER_TIMEOUT_MS: "1000",
      CHRISTIE_PROVIDER: "openai_compatible", CHRISTIE_ALLOW_EXTERNAL_PROVIDER: "true", CHRISTIE_PROVIDER_URL: provider.url, CHRISTIE_PROVIDER_MODEL: "fake-tutor" });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    // A big district: 6,000 more students, with the one we'll name last, at S2.
    await admin.query(`INSERT INTO students(district_id, school_id, local_student_number, display_name, grade_level)
      SELECT $1, $2, 'BULK-' || g, 'Pupil' || g || ' Sample', '4' FROM generate_series(1, 6000) g`, [ID.d1, ID.s2]);
    await admin.query(`INSERT INTO students(district_id, school_id, local_student_number, display_name, grade_level) VALUES ($1,$2,'2026-55417','Marisol Okonkwo-Reyes','5')`, [ID.d1, ID.s2]);
    // Names and numbers stored with punctuation and separators.
    await admin.query(`INSERT INTO students(district_id, school_id, local_student_number, display_name, grade_level) VALUES
      ($1,$2,'A/2026/001','Doe, Jane','5'), ($1,$2,'SIS 2026 55417','Ravi Kumar','5'), ($1,$2,'77.431.K','Tomás de la Cruz','5')`, [ID.d1, ID.s2]);
    // Names in many scripts, one stored decomposed (NFD), and one of single letters.
    for (const [n, name] of Object.entries(INTERNATIONAL))
      await admin.query("INSERT INTO students(district_id, school_id, local_student_number, display_name, grade_level) VALUES ($1,$2,$3,$4,'4')", [ID.d1, ID.s2, `INTL-${n}`, name]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "supt2", "p1", "t1", "vp1", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    const p = await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft", "resource_summary", "writing_feedback"], dailyTokenCap: 1000000, userDailyTokenCap: 1000000, externalProviderEnabled: true, privacyAcknowledged: true });
    assert.equal(p.status, 200, JSON.stringify({ body: p.body, serverLog: server.log() }));
  });
  after(async () => { await server?.stop(); await admin?.end(); await provider?.close(); await idp?.close(); await db?.drop(); });

  it("privacy migration defaults every district to deny and enforces acknowledgement in the database", async () => {
    const inserted = await admin.query(`INSERT INTO ai_district_policy(district_id, enabled_usecases, daily_token_cap, user_daily_token_cap)
      VALUES ($1, ARRAY[]::text[], 1000, 1000)
      RETURNING external_provider_enabled, external_provider_acknowledged_at, external_provider_acknowledged_by`, [ID.d2]);
    assert.deepEqual(inserted.rows[0], {
      external_provider_enabled: false,
      external_provider_acknowledged_at: null,
      external_provider_acknowledged_by: null
    });
    await assert.rejects(
      admin.query("UPDATE ai_district_policy SET external_provider_enabled=true WHERE district_id=$1", [ID.d2]),
      /ai_external_provider_ack_required/
    );
  });
  it("external-provider policy reads, writes and revocation stay isolated between districts", async () => {
    const d2Before = await as("supt2")("GET", "/api/ai/policy");
    assert.equal(d2Before.status, 200, JSON.stringify(d2Before.body));
    assert.equal(d2Before.body.data.externalProviderEnabled, false);
    const enabled = await as("supt2")("PUT", "/api/ai/policy", {
      enabledUsecases: ["lesson_draft"], dailyTokenCap: 1000000, userDailyTokenCap: 1000000,
      externalProviderEnabled: true, privacyAcknowledged: true
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    assert.equal((await as("supt2")("GET", "/api/ai/policy")).body.data.externalProviderEnabled, true);
    assert.equal((await as("supt1")("GET", "/api/ai/policy")).body.data.externalProviderEnabled, true,
      "changing district two did not alter district one's policy");
    const revoked = await as("supt2")("PUT", "/api/ai/policy", {
      enabledUsecases: ["lesson_draft"], dailyTokenCap: 1000000, userDailyTokenCap: 1000000,
      externalProviderEnabled: false
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal((await as("supt2")("GET", "/api/ai/policy")).body.data.externalProviderEnabled, false);
    assert.equal((await as("supt1")("GET", "/api/ai/policy")).body.data.externalProviderEnabled, true,
      "revoking district two did not revoke district one");
  });

  it("district external-provider opt-in is default-deny and blocks egress until acknowledged", async () => {
    const disabled = await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft"], dailyTokenCap: 1000000, userDailyTokenCap: 1000000, externalProviderEnabled: false });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    const before = provider.received.length;
    const denied = await runAi("supt1", "lesson_draft", "Volcanoes");
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error, "ai_external_provider_disabled");
    assert.equal(provider.received.length, before, "no request reached the external provider");
    const unacknowledged = await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft"], dailyTokenCap: 1000000, userDailyTokenCap: 1000000, externalProviderEnabled: true });
    assert.equal(unacknowledged.status, 400, "enabling requires an explicit privacy acknowledgement");
    const enabled = await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft"], dailyTokenCap: 1000000, userDailyTokenCap: 1000000, externalProviderEnabled: true, privacyAcknowledged: true });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    // Restore the broader policy expected by subsequent privacy/budget tests.
    const restored = await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft", "resource_summary", "writing_feedback"], dailyTokenCap: 1000000, userDailyTokenCap: 1000000, externalProviderEnabled: true, privacyAcknowledged: true });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
  });
  it("revoking external AI while a request waits for the district budget lock blocks provider egress", async () => {
    const lock = new pg.Client(db.adminUrl); await lock.connect();
    const sentBefore = provider.received.length;
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtext('eduos-ai-budget'), hashtext($1::text))", [ID.d1]);
      let done = false;
      const pending = runAi("p1", "resource_summary", "A resource about the water cycle for elementary teachers.").then(r => { done = true; return r; });
      await new Promise(r => setTimeout(r, 500));
      assert.equal(done, false, "the request waits for the district budget lock");
      await lock.query("UPDATE ai_district_policy SET external_provider_enabled=false, external_provider_acknowledged_at=NULL, external_provider_acknowledged_by=NULL WHERE district_id=$1", [ID.d1]);
      await lock.query("COMMIT");
      const result = await pending;
      assert.equal(result.status, 403, JSON.stringify(result.body));
      assert.equal(result.body.error, "ai_external_provider_disabled");
      assert.equal(provider.received.length, sentBefore, "the revoked request never reaches the external provider");
    } finally {
      await lock.query("ROLLBACK").catch(() => {});
      await lock.end();
    }
    const restored = await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft", "resource_summary", "writing_feedback"], dailyTokenCap: 1000000, userDailyTokenCap: 1000000, externalProviderEnabled: true, privacyAcknowledged: true });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
  });
  it("Christie: a learner's question loses the names of their family and teachers, titled adults, addresses, birth dates and links (EDUOS-PRIV-01)", async () => {
    await admin.query("UPDATE users SET display_name='Grace Okafor' WHERE id=$1", [USERS.pa[0]]);
    await admin.query("UPDATE users SET display_name='Hollis Varga' WHERE id=$1", [USERS.t1[0]]);
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES ($1,$2,$3,$4,$3) ON CONFLICT DO NOTHING",
      [ID.d1, ID.s1, USERS.t1[0], ID.alice]);
    const made = await as("t1")("POST", "/api/christie/skills", { subject: "Math", gradeLevel: "3", code: "G3.PRIV", title: "Thirds",
      explanation: "Split a whole into three equal parts.", items: [{ prompt: "What is 1/3 of 9?", answer: "3", hints: ["Make three groups."] }] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await as("p1")("POST", `/api/christie/skills/${made.body.data.id}/approve`)).status, 200);
    const sid = (await as("pu")("POST", "/api/christie/sessions", { skillId: made.body.data.id })).body.data.session.id;
    const before = provider.received.length;
    const asked = await as("pu")("POST", `/api/christie/sessions/${sid}/turns`, { kind: "question",
      text: "Grace Okafor and Mr Varga said Coach Bellweather knows, I live at 42 Maple Street Apt 3, birthday March 4, 2015, see www.example.org/me" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(provider.received.length, before + 1, "the external tutor was asked");
    const whole = JSON.stringify(provider.received.at(-1));
    for (const leak of ["Grace", "Okafor", "Varga", "Hollis", "Bellweather", "42 Maple", "Maple Street", "March 4, 2015", "example.org"])
      assert.ok(!whole.includes(leak), `"${leak}" reached the tutor provider: ${whole}`);
    assert.match(whole, /What is 1\/3 of 9\?/, "the problem itself still goes");
  });

  it("a superintendent's text loses every student name and number in the district before it leaves", async () => {
    const filler = "The visit covered reading groups and the new schedule. ".repeat(12);
    const text = `Visit notes. Marisol Okonkwo-Reyes (2026-55417) and Carol C need follow-up; Pupil5999 Sample too. ${filler} Final line: END-OF-NOTES marker.`;
    assert.ok(text.length > 600);
    const r = await runAi("supt1", "resource_summary", text);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.source, "external");
    const sent = sentText();
    for (const leak of ["Marisol", "Okonkwo-Reyes", "2026-55417", "Carol", "Pupil5999", "BULK-5999"]) assert.ok(!sent.includes(leak), `${leak} reached the provider: ${sent.slice(0, 200)}`);
    assert.match(sent, /END-OF-NOTES marker/, "the whole text was sent, not the first 500 characters");
    assert.equal(provider.received.at(-1).model, "fake-model");
  });

  it("a teacher's text loses students from any school in the district, not only their roster", async () => {
    const r = await runAi("t1", "writing_feedback", "Feedback for Marisol Okonkwo-Reyes, student 2026-55417, and for Bob B on the argument essay.");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sent = sentText();
    for (const leak of ["Marisol", "Okonkwo-Reyes", "2026-55417", "Bob"]) assert.ok(!sent.includes(leak), leak);
  });

  it("names in any script, accents, apostrophes and one-letter names never reach the provider", async () => {
    const text = "Visit: Мария Иванова и Иванова; 李小龍今天缺席；山田花子さん; 김민준이 결석; محمد علي متأخر; José Núñez y Núñez; O'Brien; Q Z left; आरव शर्मा आज. END";
    const r = await runAi("supt1", "resource_summary", text);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sent = sentText().normalize("NFC");
    for (const leak of ["Мария", "Иванова", "李小龍", "山田", "花子", "김민준", "محمد", "علي", "José", "Núñez", "O'Brien", "Q Z", "आरव", "शर्मा", "INTL-"])
      assert.ok(!sent.includes(leak.normalize("NFC")), `${leak} reached the provider: ${sent}`);
    assert.match(sent, /END$/);
  });

  it("surnames alone, names stored with commas, and student numbers with separators never reach the provider", async () => {
    const cases = [
      ["Okonkwo-Reyes needs follow-up on the reading plan this week.", ["Okonkwo", "Reyes"]],
      ["Doe was late twice this week and needs a check-in call.", ["Doe"]],
      ["MARISOL and jane were paired for the science project today.", ["MARISOL", "jane"]],
      ["Plans needed for SIS 2026 55417, SIS-2026-55417, SIS202655417 and A/2026/001.", ["55417", "A/2026/001", "2026/001", "SIS"]],
      ["Record 77.431.K and 77 431 K belong to Cruz, who moved schools.", ["431", "Cruz"]],
    ];
    for (const [text, leaks] of cases) {
      const r = await runAi("supt1", "resource_summary", text);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const sent = sentText();
      for (const leak of leaks) assert.ok(!sent.includes(leak), `"${leak}" reached the provider from "${text}": ${sent}`);
    }
    // Documented policy: a lone initial is not a name; the whole name is.
    await runAi("supt1", "resource_summary", "Group Q met today; Q Z was absent from it.");
    assert.equal(sentText(), "Group Q met today; [name] was absent from it.");
  });

  it("Christie: every field sent to an external tutor model is sanitized, not just the question", async () => {
    const made = await as("t1")("POST", "/api/christie/skills", { subject: "Math", gradeLevel: "3", code: "G3.HALF", title: "Halves with Marisol",
      explanation: "Okonkwo-Reyes (SIS 2026 55417) shared a pizza with 李小龍. In all there were 123456 + 654321 crumbs.",
      items: [{ prompt: "Doe has 1/2 of 10 apples. How many apples?", answer: "5", hints: ["Ask Jane Doe how she halves.", "Split 10 into two equal groups."] }] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await as("p1")("POST", `/api/christie/skills/${made.body.data.id}/approve`)).status, 200);
    const sid = (await as("pu")("POST", "/api/christie/sessions", { skillId: made.body.data.id })).body.data.session.id;
    const turn = (body) => as("pu")("POST", `/api/christie/sessions/${sid}/turns`, body);
    const wrong = await turn({ kind: "attempt", text: "7" }); // unlocks the first hint
    assert.match(wrong.body.data.replies[0].text, /Ask Jane Doe/, "the learner's own (local) hint is untouched");
    const before = provider.received.length;
    const asked = await turn({ kind: "question", text: "Why do Bob B and Carol split it differently than Мария Иванова?" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(provider.received.length, before + 1, "the external tutor was asked");
    const body = provider.received.at(-1);
    assert.equal(body.model, "fake-tutor");
    const whole = JSON.stringify(body).normalize("NFC");
    for (const leak of ["Marisol", "Okonkwo", "Reyes", "55417", "李小龍", "Doe", "Jane", "Bob", "Carol", "Мария", "Иванова", "Alice", "Pupil A"])
      assert.ok(!whole.includes(leak), `"${leak}" reached the tutor provider: ${whole}`);
    const sent = JSON.parse(body.messages[1].content);
    assert.match(sent.approved_lesson, /123456 \+ 654321 crumbs/, "lesson arithmetic is left alone");
    assert.match(sent.problem, /has 1\/2 of 10 apples/);
    assert.deepEqual(sent.hints_already_shown, ["Ask [name] [name] how she halves."]);
    assert.equal(asked.body.data.replies.at(-1).text, "OK from the model");
  });

  it("no usage report, or a nonsense one: the full reservation stands", async () => {
    for (const marker of ["NO-USAGE", "BAD-USAGE"]) {
      const r = await runAi("supt1", "resource_summary", `${"教育資源".repeat(500)} ${marker} end of resource.`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.source, "external");
      const row = (await admin.query("SELECT tokens_in + tokens_out AS n, outcome FROM ai_usage ORDER BY id DESC LIMIT 1")).rows[0];
      const detail = (await admin.query("SELECT detail FROM audit_events WHERE action='ai_resource_summary' ORDER BY occurred_at DESC LIMIT 1")).rows[0].detail;
      const reserved = Number(/usage=reserved; reserved=(\d+)/.exec(detail)?.[1]);
      assert.ok(reserved > 6000, `${marker}: ${detail}`); // 2,000 CJK characters are 6,000 bytes
      assert.equal(row.n, reserved, `${marker}: settled at the reservation, not at characters/4`);
    }
    const reported = (await admin.query("SELECT detail FROM audit_events WHERE action='ai_resource_summary' AND detail LIKE '%usage=reported%' LIMIT 1")).rows;
    assert.equal(reported.length, 1, "reported usage is labelled as such");
  });

  it("a budget lowered while a request waits is the budget that request gets", async () => {
    const lock = new pg.Client(db.adminUrl); await lock.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtext('eduos-ai-budget'), hashtext($1::text))", [ID.d1]);
      const sentBefore = provider.received.length;
      let done = false;
      const pending = runAi("p1", "resource_summary", "A short resource about clouds and rain for year four.").then(r => { done = true; return r; });
      await new Promise(r => setTimeout(r, 500));
      assert.equal(done, false, "the request waits for the district lock");
      // The request has already read the old, generous policy. Lower the cap, then let it go.
      await lock.query("UPDATE ai_district_policy SET daily_token_cap = 5 WHERE district_id = $1", [ID.d1]);
      await lock.query("COMMIT");
      const r = await pending;
      if (r.status === 200) assert.fail("the request reserved against the stale policy");
      assert.equal(r.status, 429, JSON.stringify(r.body));
      assert.equal(provider.received.length, sentBefore, "nothing was sent");
      // A policy change takes the same lock, so it and a reservation never overlap.
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtext('eduos-ai-budget'), hashtext($1::text))", [ID.d1]);
      let saved = false;
      const put = as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft", "resource_summary", "writing_feedback"], dailyTokenCap: 1000000, userDailyTokenCap: 1000000 }).then(x => { saved = true; return x; });
      await new Promise(x => setTimeout(x, 400));
      assert.equal(saved, false, "the policy change waits for the district lock");
      await lock.query("COMMIT");
      assert.equal((await put).status, 200);
    } finally { await lock.query("ROLLBACK").catch(() => {}); await lock.end(); }
    await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft", "resource_summary", "writing_feedback"], dailyTokenCap: 1000000, userDailyTokenCap: 1000000, externalProviderEnabled: true, privacyAcknowledged: true });
  });

  it("a request bigger than a budget is refused before anything is sent", async () => {
    await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft", "resource_summary", "writing_feedback"], dailyTokenCap: 1000000, userDailyTokenCap: 20000 });
    const before = provider.received.length;
    const r = await runAi("supt1", "resource_summary", "教".repeat(8000)); // 24,000 bytes: more than 20,000 tokens could be needed
    assert.equal(r.status, 429); assert.equal(r.body.error, "ai_request_exceeds_budget");
    assert.equal(provider.received.length, before);
    await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft", "resource_summary", "writing_feedback"], dailyTokenCap: 1000000, userDailyTokenCap: 1000000, externalProviderEnabled: true, privacyAcknowledged: true });
  });

  it("a provider that reports more than it could have used is recorded and flagged", async () => {
    const r = await runAi("supt1", "resource_summary", "Please summarize this INFLATE-USAGE test resource text now.");
    assert.equal(r.status, 200);
    const row = (await admin.query("SELECT tokens_in, outcome FROM ai_usage ORDER BY id DESC LIMIT 1")).rows[0];
    assert.deepEqual(row, { tokens_in: 999999, outcome: "ok" }, "what the provider will bill is what counts");
    const a = (await admin.query("SELECT detail FROM audit_events WHERE action='ai_resource_summary' ORDER BY occurred_at DESC LIMIT 1")).rows[0];
    assert.match(a.detail, /over_reservation/);
    await admin.query("DELETE FROM ai_usage WHERE tokens_in = 999999"); // keep the next tests' budget arithmetic simple
  });

  it("a provider that never answers is cut off: local answer, reservation settled", async () => {
    const t0 = Date.now();
    const r = await runAi("supt1", "resource_summary", "Summarize HANG-FOREVER: a resource about water cycles and clouds.");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.source, "local");
    assert.ok(Date.now() - t0 < 10000, "cut off at the provider timeout");
    const row = (await admin.query("SELECT outcome, tokens_in + tokens_out AS n FROM ai_usage ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(row.outcome, "fallback");
    // The provider was sent the request and may still process and bill it:
    // the reservation is kept in full, not released.
    const detail = (await admin.query("SELECT detail FROM audit_events WHERE action='ai_resource_summary' ORDER BY occurred_at DESC LIMIT 1")).rows[0].detail;
    assert.equal(row.n, Number(/usage=reserved; reserved=(\d+)/.exec(detail)?.[1]), detail);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM ai_usage WHERE outcome='pending'")).rows[0].n, 0);
  });

  it("bookkeeping that fails after the provider was called never gives the budget back", async () => {
    // Make every settlement of a reservation fail in the database.
    await admin.query(`CREATE FUNCTION test_block_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.outcome = 'pending' AND NEW.outcome <> 'pending' THEN RAISE EXCEPTION 'settlement blocked for the test'; END IF; RETURN NEW; END $$`);
    await admin.query("CREATE TRIGGER test_block_settlement BEFORE UPDATE ON ai_usage FOR EACH ROW EXECUTE FUNCTION test_block_settlement()");
    try {
      const before = provider.received.length;
      const usedBefore = (await as("supt1")("GET", "/api/ai/status")).body.data.budget.district.used;
      const r = await runAi("p1", "resource_summary", "A resource about rivers, deltas and flood plains for year five.");
      assert.equal(r.status, 500, "the request fails: its usage could not be recorded");
      assert.equal(provider.received.length, before + 1, "but the provider did receive (and may bill) it");
      const row = (await admin.query("SELECT id, outcome, tokens_in + tokens_out AS n FROM ai_usage ORDER BY id DESC LIMIT 1")).rows[0];
      assert.equal(row.outcome, "pending", "the reservation was not released");
      assert.ok(row.n > 900, `still holds its full reservation (${row.n})`);
      const usedAfter = (await as("supt1")("GET", "/api/ai/status")).body.data.budget.district.used;
      assert.equal(usedAfter - usedBefore, row.n, "and it still counts against the budget");
      // It never lapses on a timer either.
      await admin.query("UPDATE ai_usage SET created_at = created_at - interval '3 hours' WHERE id = $1 AND created_at - interval '3 hours' >= date_trunc('day', now())", [row.id]);
      assert.equal((await as("supt1")("GET", "/api/ai/status")).body.data.budget.district.used, usedAfter);
      await admin.query("DROP TRIGGER test_block_settlement ON ai_usage");
      await admin.query("DELETE FROM ai_usage WHERE id = $1", [row.id]); // keep the next tests' arithmetic simple
    } finally {
      await admin.query("DROP TRIGGER IF EXISTS test_block_settlement ON ai_usage");
      await admin.query("DROP FUNCTION IF EXISTS test_block_settlement()");
    }
  });

  it("one person's 20 simultaneous requests stay within their own budget", async () => {
    const u = (await admin.query("SELECT coalesce(sum(tokens_in + tokens_out), 0)::int AS n FROM ai_usage WHERE user_id = $1", [USERS.vp1[0]])).rows[0].n;
    // A "Volcanoes" lesson draft reserves about 1,300 tokens (system prompt +
    // text + framing + 900 output) and uses 950: room for two, never three.
    await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft"], dailyTokenCap: 1000000, userDailyTokenCap: u + 2700 });
    const before = provider.received.length;
    const results = await Promise.all(Array.from({ length: 20 }, () => runAi("vp1", "lesson_draft", "Volcanoes")));
    const ok = results.filter(r => r.status === 200).length;
    assert.ok(ok >= 1 && ok <= 2, `${ok} got through`);
    assert.ok(results.every(r => r.status === 200 || r.body.error === "ai_your_budget_reached"), JSON.stringify(results.map(r => r.body?.error)));
    assert.equal(provider.received.length - before, ok);
    const after = (await admin.query("SELECT coalesce(sum(tokens_in + tokens_out), 0)::int AS n FROM ai_usage WHERE user_id = $1", [USERS.vp1[0]])).rows[0].n;
    assert.ok(after <= u + 2700, `${after - u} of 2,700`);
  });

  it("20 simultaneous requests against a nearly spent budget stay within it", async () => {
    const used = (await admin.query("SELECT coalesce(sum(tokens_in + tokens_out), 0)::int AS n FROM ai_usage WHERE district_id = $1", [ID.d1])).rows[0].n;
    // Each reserves about 1,300 tokens and uses 950: room for three at most
    // (four would use 3,800), however the requests interleave.
    const cap = used + 3700;
    await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft"], dailyTokenCap: cap, userDailyTokenCap: 1000000, externalProviderEnabled: true, privacyAcknowledged: true });
    const sentBefore = provider.received.length;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => runAi(i % 2 ? "p1" : "t1", "lesson_draft", "Volcanoes")));
    const ok = results.filter(r => r.status === 200).length;
    assert.ok(ok >= 1 && ok <= 3, `${ok} requests got through (each uses 950 of the 3,700 left)`);
    assert.ok(results.every(r => r.status === 200 || r.body.error === "ai_district_budget_reached"), JSON.stringify(results.map(r => r.body?.error || r.status)));
    assert.equal(provider.received.length - sentBefore, ok, "only requests within budget reached the provider");
    const after = (await admin.query("SELECT coalesce(sum(tokens_in + tokens_out), 0)::int AS n, count(*) FILTER (WHERE outcome = 'pending')::int AS pending FROM ai_usage WHERE district_id = $1", [ID.d1])).rows[0];
    assert.ok(after.n <= cap, `used ${after.n} of ${cap}`);
    assert.equal(after.pending, 0, "every reservation was settled");
  });
});
