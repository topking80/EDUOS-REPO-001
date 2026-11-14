// EduOS 32.3.0 school branding against real PostgreSQL, as the non-owner
// runtime role: who may edit, draft -> publish -> restore lifecycle, the AA
// contrast publish gate, upload processing, the public landing, RLS.
// Run: EDUOS_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:integration
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import sharp from "sharp";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("EduOS 32.3.0 school branding against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, appDb, sink, s = {};
  const hooks = [];
  const as = name => client(server.base, s[name]);
  const upload = async (name, scope, buf, type = "image/png") => {
    const res = await fetch(`${server.base}/api/branding/${scope}/mascot`, { method: "POST", headers: { cookie: s[name].cookie, "x-csrf-token": s[name].csrf, "content-type": type }, body: buf });
    const text = await res.text(); let body = null; try { body = JSON.parse(text); } catch {}
    return { status: res.status, body: body ?? text };
  };
  const asRole = async (role, user, school, sql, params = []) => {
    await appDb.query("BEGIN");
    try {
      await appDb.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true),set_config('app.school_id',$4,true)", [ID.d1, user, role, school ?? ""]);
      return (await appDb.query(sql, params)).rows;
    } finally { await appDb.query("ROLLBACK"); }
  };
  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    sink = http.createServer((req, res) => { let b = ""; req.on("data", d => b += d); req.on("end", () => { try { hooks.push(JSON.parse(b)); } catch {} res.end("ok"); }); });
    await new Promise(r => sink.listen(0, "127.0.0.1", r));
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, WEBHOOK_SIGNING_KEY: "w".repeat(40), WEBHOOK_ALLOW_INSECURE_LOOPBACK: "true", BRANDING_UPLOAD_MAX_KB: "512" });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    appDb = new pg.Client(db.appUrl); await appDb.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "p1", "p2", "t1", "pu", "pa", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => {
    if (process.env.EDUOS_IT_DEBUG) console.log(server?.log().split("\n").filter(l => /fail|error/i.test(l)).join("\n"));
    await server?.stop(); await appDb?.end(); await admin?.end(); await idp?.close();
    sink?.closeAllConnections?.(); await new Promise(r => sink ? sink.close(r) : r()); await db?.drop?.();
  });

  it("only district roles and a school's own principal may edit; others read published branding only", async () => {
    assert.equal((await as("p1")("PUT", `/api/branding/${ID.s1}/draft`, { primary: "#123a6b", mascotName: "Otters" })).status, 200);
    assert.equal((await as("p1")("PUT", `/api/branding/${ID.s2}/draft`, { primary: "#000000" })).status, 403, "principal cannot edit another school");
    assert.equal((await as("p1")("PUT", "/api/branding/district/draft", { primary: "#000000" })).status, 403, "principal cannot edit the district default");
    for (const who of ["t1", "pu", "pa"]) assert.equal((await as(who)("PUT", `/api/branding/${ID.s1}/draft`, { primary: "#000000" })).status, 403, who);
    assert.equal((await as("t1")("GET", `/api/branding/${ID.s1}`)).status, 403);
    assert.equal((await as("supt2")("PUT", `/api/branding/${ID.s1}/draft`, { primary: "#000000" })).status, 404, "other district cannot see the school");
    // RLS, directly as the runtime role: principal S1 cannot write S2 even bypassing the API.
    await assert.rejects(asRole("principal", USERS.p1[0], ID.s1,
      `INSERT INTO branding_profiles(district_id,school_id,status,created_by) VALUES($1,$2,'draft',$3)`, [ID.d1, ID.s2, USERS.p1[0]]));
    await assert.rejects(asRole("teacher", USERS.t1[0], ID.s1,
      `INSERT INTO branding_profiles(district_id,school_id,status,created_by) VALUES($1,$2,'draft',$3)`, [ID.d1, ID.s1, USERS.t1[0]]));
    const teacherSeesDraft = await asRole("teacher", USERS.t1[0], ID.s1, "SELECT count(*)::int AS n FROM branding_profiles WHERE status='draft'");
    assert.equal(teacherSeesDraft[0].n, 0, "drafts are invisible to non-editors");
    const p2SeesS1 = await asRole("principal", USERS.p2[0], ID.s2, "SELECT count(*)::int AS n FROM branding_profiles WHERE school_id=$1", [ID.s1]);
    assert.equal(p2SeesS1[0].n, 0);
    const cur = await as("t1")("GET", "/api/branding/current");
    assert.equal(cur.status, 200); assert.equal(cur.body.data.branding.primary, "#1f4e79", "the unpublished draft is not shown");
  });

  it("draft -> publish -> restore -> reset lifecycle with audit and a webhook event", async () => {
    const url = `http://127.0.0.1:${sink.address().port}/b`;
    assert.equal((await as("supt1")("POST", "/api/webhooks", { url, eventTypes: ["branding.published"] })).status, 201);
    const pub = await as("p1")("POST", `/api/branding/${ID.s1}/publish`);
    assert.equal(pub.status, 200, JSON.stringify(pub.body)); assert.equal(pub.body.data.version, 1);
    const cur = await as("pu")("GET", "/api/branding/current");
    assert.equal(cur.body.data.branding.primary, "#123a6b"); assert.equal(cur.body.data.branding.mascotName, "Otters");
    assert.equal((await as("pa")("GET", "/api/branding/current")).body.data.branding.primary, "#123a6b", "guardian at S1 sees it");
    assert.equal((await as("p2")("GET", "/api/branding/current")).body.data.branding.primary, "#1f4e79", "S2 is unaffected");
    // District default flows to schools without their own value.
    assert.equal((await as("supt1")("PUT", "/api/branding/district/draft", { secondary: "#5b2a86", accent: "#e8a33d" })).status, 200);
    assert.equal((await as("supt1")("POST", "/api/branding/district/publish")).status, 200);
    const s2 = (await as("p2")("GET", "/api/branding/current")).body.data.branding;
    assert.equal(s2.secondary, "#5b2a86"); assert.equal((await as("t1")("GET", "/api/branding/current")).body.data.branding.secondary, "#5b2a86", "S1 inherits fields it left empty");
    // v2, then restore v1 into the draft and publish it as v3.
    await as("p1")("PUT", `/api/branding/${ID.s1}/draft`, { primary: "#0b5d3b", motto: "Swim together" });
    assert.equal((await as("p1")("POST", `/api/branding/${ID.s1}/publish`)).body.data.version, 2);
    const restored = await as("p1")("POST", `/api/branding/${ID.s1}/restore`, { version: 1 });
    assert.equal(restored.status, 200); assert.equal(restored.body.data.draft.primary, "#123a6b"); assert.equal(restored.body.data.draft.basedOnVersion, 1);
    assert.equal((await as("t1")("GET", "/api/branding/current")).body.data.branding.primary, "#0b5d3b", "restoring only changes the draft");
    assert.equal((await as("p1")("POST", `/api/branding/${ID.s1}/publish`)).body.data.version, 3);
    assert.equal((await as("t1")("GET", "/api/branding/current")).body.data.branding.primary, "#123a6b");
    const view = (await as("p1")("GET", `/api/branding/${ID.s1}`)).body.data;
    assert.deepEqual(view.history.map(h => [h.version, h.status]), [[3, "published"], [2, "archived"], [1, "archived"]]);
    // Reset: draft inherits everything; publishing it reverts S1 to the district default.
    const reset = await as("p1")("POST", `/api/branding/${ID.s1}/reset`);
    assert.equal(reset.body.data.draft.primary, null); assert.equal(reset.body.data.effective.secondary, "#5b2a86");
    assert.equal((await as("p1")("DELETE", `/api/branding/${ID.s1}/draft`)).status, 200);
    assert.equal((await as("p1")("POST", `/api/branding/${ID.s1}/publish`)).body.error, "no_draft");
    const audits = await admin.query("SELECT action FROM audit_events WHERE resource_type='branding' AND school_id=$1 ORDER BY occurred_at", [ID.s1]);
    for (const a of ["draft.save", "publish", "restore", "reset", "draft.discard"]) assert.ok(audits.rows.some(r => r.action === a), a);
    for (let i = 0; i < 50 && hooks.filter(h => (h.type || h.event?.type) === "branding.published").length < 4; i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(hooks.filter(h => JSON.stringify(h).includes("branding.published")).length >= 4, `webhook deliveries: ${JSON.stringify(hooks).slice(0, 300)}`);
    // Published history cannot be deleted by the runtime role.
    const del = await asRole("principal", USERS.p1[0], ID.s1, "DELETE FROM branding_profiles WHERE school_id=$1 AND status<>'draft' RETURNING id", [ID.s1]);
    assert.equal(del.length, 0);
  });

  it("publishing is blocked when a text pair fails WCAG AA; icon pairs only warn", async () => {
    const bad = { preset: "custom", base: { shape: "rounded", bg: "accent", labelColor: "#ffffff", glyphMode: "mono", glyphColor: "auto", badge: false }, overrides: {} };
    const saved = await as("p2")("PUT", `/api/branding/${ID.s2}/draft`, { accent: "#f6c445", tiles: bad });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.contrast.summary.ok, false);
    const err = saved.body.data.contrast.report.find(r => r.level === "error");
    assert.equal(err.fg, "#ffffff"); assert.ok(err.ratio < 4.5); assert.match(err.suggestion, /^#[0-9a-f]{6}$/);
    const blocked = await as("p2")("POST", `/api/branding/${ID.s2}/publish`);
    assert.equal(blocked.status, 422); assert.equal(blocked.body.error, "contrast_failed"); assert.ok(blocked.body.contrast.summary.errors > 0);
    assert.equal((await as("pu")("GET", "/api/branding/current")).body.data.branding.accent, "#e8a33d", "nothing published");
    // Apply the suggestion: now it publishes. A weak icon colour is a warning, not a block.
    const fixed = { ...bad, base: { ...bad.base, labelColor: err.suggestion, glyphColor: "#f9d77a" } };
    const ok = await as("p2")("PUT", `/api/branding/${ID.s2}/draft`, { tiles: fixed });
    assert.equal(ok.body.data.contrast.summary.ok, true); assert.ok(ok.body.data.contrast.summary.warnings > 0);
    assert.equal((await as("p2")("POST", `/api/branding/${ID.s2}/publish`)).status, 200);
    assert.equal((await as("p2")("PUT", `/api/branding/${ID.s2}/draft`, { primary: "red" })).body.error, "invalid_primary");
    assert.equal((await as("p2")("PUT", `/api/branding/${ID.s2}/draft`, { tiles: { preset: "custom", base: { bg: "url(x)" }, overrides: {} } })).body.error, "invalid_tile_bg");
    assert.equal((await as("p2")("PUT", `/api/branding/${ID.s2}/draft`, { font: "Comic Sans" })).body.error, "invalid_font");
  });

  it("uploads are re-encoded, stripped, cropped and sanitized; bad files are refused", async () => {
    const jpg = await sharp({ create: { width: 640, height: 400, channels: 3, background: "#123a6b" } }).jpeg()
      .withMetadata({ exif: { IFD0: { Artist: "secret-exif-marker" } } }).toBuffer();
    const up = await upload("p1", ID.s1, jpg, "image/jpeg");
    assert.equal(up.status, 201, JSON.stringify(up.body)); assert.equal(up.body.data.type, "jpeg");
    const rows = await admin.query("SELECT variant,mime,width,height,bytes FROM branding_assets WHERE upload_id=$1 ORDER BY variant", [up.body.data.uploadId]);
    assert.deepEqual(rows.rows.map(r => r.variant).sort(), ["png_180", "png_192", "png_32", "png_48", "png_512", "png_96"]);
    for (const r of rows.rows) { assert.equal(r.mime, "image/png"); assert.equal(r.width, r.height); assert.ok(!r.bytes.includes(Buffer.from("secret-exif-marker"))); }
    const img = await fetch(`${server.base}${up.body.data.urls[96]}`, { headers: { cookie: s.t1.cookie } });
    assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/png"); assert.equal(img.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await fetch(`${server.base}${up.body.data.urls[96]}`, { headers: { cookie: s.p2.cookie } })).status, 404, "another school's upload is invisible");
    const evil = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" onload="alert(1)"><script>alert(1)</script><foreignObject><b>x</b></foreignObject><image href="https://evil.example/a.png"/><circle cx="32" cy="32" r="30" fill="#0b5d3b"/></svg>`;
    const sv = await upload("p1", ID.s1, Buffer.from(evil), "image/svg+xml");
    assert.equal(sv.status, 201, JSON.stringify(sv.body)); assert.ok(sv.body.data.removed.includes("<script>"));
    const clean = (await admin.query("SELECT convert_from(bytes,'UTF8') AS t FROM branding_assets WHERE upload_id=$1 AND variant='svg'", [sv.body.data.uploadId])).rows[0].t;
    assert.doesNotMatch(clean, /script|onload|foreignObject|image|evil/i);
    const svgRes = await fetch(`${server.base}/api/branding/assets/${sv.body.data.uploadId}/svg`, { headers: { cookie: s.p1.cookie } });
    assert.match(svgRes.headers.get("content-security-policy"), /default-src 'none'.*sandbox/);
    assert.equal((await upload("p1", ID.s1, Buffer.from('<!DOCTYPE svg [<!ENTITY a "x">]><svg/>'), "image/svg+xml")).body.reason, "doctype_entity_or_cdata");
    assert.equal((await upload("p1", ID.s1, Buffer.from("GIF89a" + "x".repeat(100)), "image/png")).body.reason, "unsupported_type", "type comes from the bytes, not the header");
    assert.equal((await upload("p1", ID.s1, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]))).body.reason, "undecodable");
    assert.equal((await upload("p1", ID.s1, Buffer.alloc(600 * 1024, 7))).status, 413);
    const tiny = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#000" } }).png().toBuffer();
    assert.equal((await upload("p1", ID.s1, tiny)).body.reason, "too_small");
    assert.equal((await upload("p2", ID.s1, jpg, "image/jpeg")).status, 403);
    assert.equal((await upload("t1", ID.s1, jpg, "image/jpeg")).status, 403);
  });

  it("public landing, icon and manifest expose only published branding", async () => {
    await as("p1")("PUT", `/api/branding/${ID.s1}/draft`, { primary: "#0b5d3b", mascotName: "Otters" });
    assert.equal((await as("p1")("POST", `/api/branding/${ID.s1}/publish`)).status, 200);
    await as("p1")("PUT", `/api/branding/${ID.s1}/draft`, { primary: "#4a0d0d" }); // unpublished
    const r = await fetch(`${server.base}/api/public/branding/${ID.d1}/${ID.s1}`);
    assert.equal(r.status, 200); const b = (await r.json()).data;
    assert.equal(b.primary, "#0b5d3b"); assert.equal(b.schoolName.length > 0, true); assert.equal(b.mascotName, "Otters");
    assert.ok(!("motto" in b) || b.motto === null || typeof b.motto === "string");
    const icon = await fetch(`${server.base}/api/public/branding/${ID.d1}/${ID.s1}/icon-192.png`);
    assert.equal(icon.status, 200); const meta = await sharp(Buffer.from(await icon.arrayBuffer())).metadata();
    assert.equal(meta.width, 192); assert.equal(meta.format, "png");
    const s2icon = await fetch(`${server.base}/api/public/branding/${ID.d1}/${ID.s2}/icon-32.png`);
    assert.equal(s2icon.status, 200, "a school without a mascot gets a generated icon");
    const man = await (await fetch(`${server.base}/api/public/branding/${ID.d1}/${ID.s1}/manifest.webmanifest`)).json();
    assert.equal(man.theme_color, "#0b5d3b"); assert.equal(man.icons.length, 2);
    assert.equal((await fetch(`${server.base}/api/public/branding/${ID.d2}/${ID.s1}`)).status, 404, "school must belong to the district");
    assert.equal((await fetch(`${server.base}/api/public/branding/not-a-uuid/${ID.s1}`)).status, 404);
  });

  it("someone in two schools sees the branding of the school currently selected", async () => {
    s.p2s = await login(server.base, idp, "p2s", { email_verified: true });
    const s1 = (await as("pa")("GET", "/api/branding/current")).body.data, s2 = (await as("p2")("GET", "/api/branding/current")).body.data;
    assert.notEqual(s1.branding.accent + s1.branding.primary, s2.branding.accent + s2.branding.primary, "the two schools differ");
    const first = (await as("p2s")("GET", "/api/branding/current")).body.data;
    assert.equal(first.school.id, ID.s1); assert.equal(first.branding.primary, s1.branding.primary);
    const m = (await as("p2s")("GET", "/api/memberships")).body.data.find(x => x.school_id === ID.s2 || x.schoolId === ID.s2);
    const sw = await as("p2s")("POST", "/api/session/membership", { membershipId: m.id });
    assert.equal(sw.status, 200, JSON.stringify(sw.body));
    const cookie = sw.headers.getSetCookie().map(c => c.split(";")[0]).find(c => c.startsWith("eduos_session=") && !c.endsWith("=")) || s.p2s.cookie;
    const after = await (await fetch(`${server.base}/api/branding/current`, { headers: { cookie } })).json();
    assert.equal(after.data.school.id, ID.s2); assert.equal(after.data.branding.primary, s2.branding.primary); assert.equal(after.data.branding.accent, s2.branding.accent);
    assert.equal(after.data.publicKey, `${ID.d1}.${ID.s2}`);
  });

  it("per-user display preference (high contrast) is private to the user", async () => {
    assert.equal((await as("pu")("PUT", "/api/me/preferences", { theme: "high_contrast" })).status, 200);
    assert.equal((await as("pu")("GET", "/api/branding/current")).body.data.preferences.theme, "high_contrast");
    assert.equal((await as("t1")("GET", "/api/branding/current")).body.data.preferences.theme, "school");
    assert.equal((await as("pu")("PUT", "/api/me/preferences", { theme: "neon" })).status, 400);
    const others = await asRole("teacher", USERS.t1[0], ID.s1, "SELECT count(*)::int AS n FROM user_preferences");
    assert.equal(others[0].n, 0);
  });
});
