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
import { PG_URL, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

function fakeProvider() {
  const received = [];
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => {
      received.push(JSON.parse(body));
      setTimeout(() => { res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "OK from the model" } }], usage: { prompt_tokens: 50, completion_tokens: 900 } })); }, 150);
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
      AI_PROVIDER_URL: provider.url, AI_PROVIDER_MODEL: "fake-model", AI_ALLOW_INSECURE_LOOPBACK: "true" });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    // A big district: 6,000 more students, with the one we'll name last, at S2.
    await admin.query(`INSERT INTO students(district_id, school_id, local_student_number, display_name, grade_level)
      SELECT $1, $2, 'BULK-' || g, 'Pupil' || g || ' Sample', '4' FROM generate_series(1, 6000) g`, [ID.d1, ID.s2]);
    await admin.query(`INSERT INTO students(district_id, school_id, local_student_number, display_name, grade_level) VALUES ($1,$2,'2026-55417','Marisol Okonkwo-Reyes','5')`, [ID.d1, ID.s2]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "p1", "t1"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    const p = await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft", "resource_summary", "writing_feedback"], dailyTokenCap: 1000000, userDailyTokenCap: 1000000 });
    assert.equal(p.status, 200, JSON.stringify(p.body));
  });
  after(async () => { await server?.stop(); await admin?.end(); await provider?.close(); await idp?.close(); await db?.drop(); });

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

  it("20 simultaneous requests against a nearly spent budget stay within it", async () => {
    const used = (await admin.query("SELECT coalesce(sum(tokens_in + tokens_out), 0)::int AS n FROM ai_usage WHERE district_id = $1", [ID.d1])).rows[0].n;
    // Room for three requests at what each really uses (950 tokens: the fake
    // provider reports 50 in + 900 out) and for three reservations (1,003 each),
    // never four, however the requests interleave.
    const cap = used + 3100;
    await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft"], dailyTokenCap: cap, userDailyTokenCap: 1000000 });
    const sentBefore = provider.received.length;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => runAi(i % 2 ? "p1" : "supt1", "lesson_draft", "Volcanoes")));
    const ok = results.filter(r => r.status === 200).length;
    assert.ok(ok >= 1 && ok <= 3, `${ok} requests got through (each uses 950 of the 3,100 left)`);
    assert.ok(results.every(r => r.status === 200 || r.body.error === "ai_district_budget_reached"), JSON.stringify(results.map(r => r.status)));
    assert.equal(provider.received.length - sentBefore, ok, "only requests within budget reached the provider");
    const after = (await admin.query("SELECT coalesce(sum(tokens_in + tokens_out), 0)::int AS n, count(*) FILTER (WHERE outcome = 'pending')::int AS pending FROM ai_usage WHERE district_id = $1", [ID.d1])).rows[0];
    assert.ok(after.n <= cap, `used ${after.n} of ${cap}`);
    assert.equal(after.pending, 0, "every reservation was settled");
  });
});
