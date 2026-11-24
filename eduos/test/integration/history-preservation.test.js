// TC-08: preserving student history media, against real PostgreSQL as the
// runtime role, a mock S3-compatible bucket (SigV4 checked, server-side copy
// with a storage class) and a mock clamd. Checksums on upload, the
// preservation job (verify, flag, recover, archive in place), legal holds
// (keep photos, block capsule release, block deletion), capacity reporting
// without names, and who may do what.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";
import pg from "pg";
import sharp from "sharp";
import { signS3 } from "../../src/s3-storage.js";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const S3 = { region: "us-east-1", accessKeyId: `TEST${crypto.randomBytes(6).toString("hex").toUpperCase()}`, secretAccessKey: crypto.randomBytes(24).toString("base64url"), bucket: "eduos-media" };
const hash = b => crypto.createHash("sha256").update(b).digest("hex");

describe("TC-08 history preservation against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, owner, s3, clam, env, s = {}, capsule, photoId;
  const objects = new Map();
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const jpeg = (bg = "#58a") => sharp({ create: { width: 800, height: 600, channels: 3, background: bg } }).jpeg().toBuffer();
  const upload = async (who, capsuleId, body, key) => {
    const csrf = (await as(who)("GET", "/api/csrf")).body.csrfToken;
    const r = await fetch(`${server.base}/api/history/capsules/${capsuleId}/photos?alt=${encodeURIComponent("Family at the lake")}`, {
      method: "POST", body, headers: { cookie: s[who].cookie, "content-type": "image/jpeg", "x-csrf-token": csrf, ...(key ? { "idempotency-key": key } : {}) } });
    return { status: r.status, body: await r.json() };
  };
  const photo = async (who, id) => fetch(`${server.base}/api/history/photos/${id}`, { headers: { cookie: s[who].cookie }, redirect: "manual" });
  const keyOf = id => [...objects.keys()].find(k => k.includes(id));
  const preserve = async () => { const r = await run(["src/history-preservation.js"], { ...env, DATABASE_URL: db.appUrl }); assert.equal(r.code, 0, r.out); if (/check failed/.test(r.out)) console.log(r.out); return JSON.parse(r.out.trim().split("\n").pop()); };
  const obj = async id => (await admin.query("SELECT sha256,integrity_status,storage_tier,verified_at FROM private_media_objects WHERE asset_id=$1", [id])).rows[0];
  const tomorrow = () => new Date(Date.now() + 86400000).toISOString();

  before(async () => {
    s3 = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x"), chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        const host = req.headers.host, path = decodeURIComponent(u.pathname), q = Object.fromEntries(u.searchParams);
        let valid = false;
        if (q["X-Amz-Signature"]) {
          const { "X-Amz-Signature": sig, "X-Amz-Algorithm": _a, "X-Amz-Credential": _c, "X-Amz-Date": d, "X-Amz-Expires": exp, "X-Amz-SignedHeaders": _sh, ...rest } = q;
          const date = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
          valid = signS3({ method: req.method, host, path, query: rest, ...S3, date, presign: Number(exp) }).signature === sig;
        } else if (req.headers.authorization) {
          const d = req.headers["x-amz-date"], signed = /SignedHeaders=([^,]+)/.exec(req.headers.authorization)[1].split(";");
          const headers = Object.fromEntries(signed.filter(h => !["host", "x-amz-date", "x-amz-content-sha256"].includes(h)).map(h => [h, req.headers[h]]));
          const date = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
          valid = signS3({ method: req.method, host, path, headers, ...S3, date, payloadHash: req.headers["x-amz-content-sha256"] }).signature === /Signature=([0-9a-f]+)/.exec(req.headers.authorization)[1];
        }
        if (!valid) { res.writeHead(403); return res.end("SignatureDoesNotMatch"); }
        if (req.method === "PUT" && req.headers["x-amz-copy-source"]) {
          const src = objects.get(decodeURIComponent(req.headers["x-amz-copy-source"]));
          if (!src) { res.writeHead(404); return res.end("<Error><Code>NoSuchKey</Code></Error>"); }
          objects.set(path, { ...src, storageClass: req.headers["x-amz-storage-class"] });
          res.writeHead(200, { "content-type": "application/xml" }); return res.end("<CopyObjectResult><ETag>x</ETag></CopyObjectResult>");
        }
        if (req.method === "PUT") { objects.set(path, { body: Buffer.concat(chunks), type: req.headers["content-type"], storageClass: "STANDARD" }); res.writeHead(200); return res.end(); }
        const o = objects.get(path);
        if (!o) { res.writeHead(404); return res.end(); }
        if (req.method === "DELETE") { objects.delete(path); res.writeHead(204); return res.end(); }
        res.writeHead(200, { "content-type": o.type, "content-length": o.body.length }); res.end(req.method === "HEAD" ? undefined : o.body);
      });
    });
    await new Promise(r => s3.listen(0, "127.0.0.1", r));
    clam = net.createServer(sock => { let buf = Buffer.alloc(0);
      sock.on("data", d => { buf = Buffer.concat([buf, d]); if (buf.length >= 14 && buf.subarray(-4).equals(Buffer.alloc(4))) sock.end("stream: OK\0"); }); });
    await new Promise(r => clam.listen(0, "127.0.0.1", r));

    db = await createDatabase();
    idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app,
      MEDIA_S3_ENDPOINT: `http://127.0.0.1:${s3.address().port}`, MEDIA_S3_REGION: S3.region, MEDIA_S3_BUCKET: S3.bucket, MEDIA_S3_PATH_STYLE: "true",
      CAPSULE_RELEASE_INTERVAL_SECONDS: "0", HISTORY_ARCHIVE_STORAGE_CLASS: "GLACIER_IR",
      MEDIA_S3_ACCESS_KEY_ID: S3.accessKeyId, MEDIA_S3_SECRET_ACCESS_KEY: S3.secretAccessKey, CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: String(clam.address().port) });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    owner = new pg.Client(db.ownerUrl); await owner.connect();
    await owner.query(`SELECT set_config('app.district_id',$1,false)`, [ID.d1]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["t1", "p1", "p2", "vp1", "supt1", "supt2", "pa", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    ok(await as("supt1")("PUT", "/api/history/media-policy", { imagesEnabled: true, maxImageBytes: 5 * 1048576, maxPerEntry: 3, maxBytesPerStudent: 50 * 1048576 }));
  });
  after(async () => { await server?.stop(); await admin?.end(); await owner?.end(); await idp?.close(); await db?.drop(); s3?.close(); clam?.close(); });

  it("a stored photo gets the checksum of exactly what was stored", async () => {
    capsule = ok(await as("pa")("POST", "/api/history/capsules", { studentId: ID.alice, title: "For Alice at 18", releaseKind: "scheduled", releaseAt: tomorrow() }), 201);
    const r = await upload("pa", capsule.id, await jpeg(), "pres-key-0001");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    photoId = r.body.data.assetId;
    const o = await obj(photoId);
    assert.equal(o.sha256, hash(objects.get(keyOf(photoId)).body));
    assert.equal(o.integrity_status, "ok");
  });

  it("the job re-checks photos, flags a changed or missing one to the superintendent, and records recovery", async () => {
    await admin.query("UPDATE private_media_objects SET verified_at=now()-interval '200 days' WHERE asset_id=$1", [photoId]);
    const good = objects.get(keyOf(photoId)).body;
    objects.get(keyOf(photoId)).body = Buffer.concat([good, Buffer.from("x")]);
    let out = await preserve();
    assert.equal(out.mismatch, 1, JSON.stringify(out));
    assert.equal((await obj(photoId)).integrity_status, "mismatch");
    const notes = (await admin.query("SELECT recipient_user_id,channel FROM notification_outbox WHERE kind='history_preservation' AND ref_id=$1", [photoId])).rows;
    assert.deepEqual(notes.map(n => n.recipient_user_id).sort(), [USERS.supt1[0], USERS.supt1b[0]].sort());
    assert.ok(notes.every(n => n.channel === "in_app"));
    let view = ok(await as("supt1")("GET", "/api/history/preservation"));
    assert.equal(view.schools.find(x => x.schoolId === ID.s1).integrity.mismatch, 1);
    assert.match(view.problems[0].text, /failed its integrity check/);
    // Put the original back (as a restore from versions would): the next run says it recovered.
    objects.get(keyOf(photoId)).body = good;
    out = await preserve();
    assert.equal(out.ok, 1, JSON.stringify(out));
    assert.equal((await obj(photoId)).integrity_status, "ok");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM history_preservation_events WHERE asset_id=$1 AND kind='recovered'", [photoId])).rows[0].n, 1);
    // Missing from the bucket.
    const saved = objects.get(keyOf(photoId)), k = keyOf(photoId);
    objects.delete(k);
    await admin.query("UPDATE private_media_objects SET verified_at=now()-interval '200 days' WHERE asset_id=$1", [photoId]);
    out = await preserve();
    assert.equal(out.missing, 1, JSON.stringify(out));
    assert.equal((await obj(photoId)).integrity_status, "missing");
    objects.set(k, saved);
    assert.equal((await preserve()).ok, 1);
    assert.equal((await preserve()).checked, 0, "nothing due until the district's next check");
  });

  it("photos old enough move to the archive class in place, re-verified, and still open", async () => {
    assert.equal((await as("supt1")("PUT", "/api/history/preservation-policy", { verifyEveryDays: 3, archiveAfterDays: 30, capacityAlertPercent: 80, recordsScheduleRef: "" })).status, 400);
    assert.equal((await as("p1")("PUT", "/api/history/preservation-policy", { verifyEveryDays: 30, archiveAfterDays: 30, capacityAlertPercent: 80 })).status, 403);
    ok(await as("supt1")("PUT", "/api/history/preservation-policy", { verifyEveryDays: 30, archiveAfterDays: 30, capacityAlertPercent: 80, recordsScheduleRef: "Board policy 8310, GS-7" }));
    assert.equal((await preserve()).archived, 0, "not old enough yet");
    await admin.query("UPDATE private_media_objects SET created_at=now()-interval '40 days' WHERE asset_id=$1", [photoId]);
    const out = await preserve();
    assert.equal(out.archived, 1, JSON.stringify(out));
    assert.equal(objects.get(keyOf(photoId)).storageClass, "GLACIER_IR");
    const o = await obj(photoId);
    assert.equal(o.storage_tier, "archive");
    assert.equal(o.sha256, hash(objects.get(keyOf(photoId)).body));
    assert.equal((await photo("pa", photoId)).status, 302, "the same link still works");
    assert.equal((await preserve()).archived, 0, "idempotent");
    const view = ok(await as("supt1")("GET", "/api/history/preservation"));
    assert.ok(view.schools.find(x => x.schoolId === ID.s1).archiveBytes > 0);
  });

  it("capacity is reported per school, without names, to the records office only", async () => {
    const supt = ok(await as("supt1")("GET", "/api/history/preservation"));
    const s1 = supt.schools.find(x => x.schoolId === ID.s1);
    assert.equal(s1.studentsWithMedia, 1);
    assert.ok(s1.usedBytes > 0);
    assert.equal(supt.donationsAffectLimits, false);
    assert.equal(supt.policy.recordsScheduleRef, "Board policy 8310, GS-7");
    assert.ok(!JSON.stringify(supt).includes("Alice"), "no student names");
    assert.ok(!JSON.stringify(supt).includes("history/"), "no storage keys");
    const p1 = ok(await as("p1")("GET", "/api/history/preservation"));
    assert.deepEqual(p1.schools.map(x => x.schoolId), [ID.s1]);
    assert.deepEqual(ok(await as("p2")("GET", "/api/history/preservation")).schools.map(x => x.schoolId), [ID.s2]);
    for (const who of ["t1", "pa", "pu"]) assert.equal((await as(who)("GET", "/api/history/preservation")).status, 403, who);
    assert.deepEqual(ok(await as("supt2")("GET", "/api/history/preservation")).schools.filter(x => x.studentsWithMedia), [], "other district sees nothing of ours");
  });

  it("a legal hold: the records office places it, only the superintendent lifts it, and it keeps everything", async () => {
    for (const [who, code] of [["t1", 403], ["pa", 403], ["p2", 404], ["supt2", 404]])
      assert.equal((await as(who)("POST", `/api/students/${ID.alice}/legal-holds`, { reason: "Records request in litigation" })).status, code, who);
    assert.equal((await as("p1")("POST", `/api/students/${ID.alice}/legal-holds`, { reason: "no" })).status, 400);
    const hold = ok(await as("vp1")("POST", `/api/students/${ID.alice}/legal-holds`, { reason: "Records request in litigation", matterRef: "Case 26-CV-0142" }), 201);
    const list = ok(await as("p1")("GET", `/api/students/${ID.alice}/legal-holds`));
    assert.equal(list.onHold, true);
    assert.equal(list.holds[0].matterRef, "Case 26-CV-0142");
    assert.equal(list.canRelease, false);
    assert.deepEqual(ok(await as("supt1")("GET", "/api/history/legal-holds")).map(h => h.id), [hold.id]);
    assert.equal((await as("p1")("GET", "/api/history/legal-holds")).status, 403);

    // Capsules don't open while it's on.
    ok(await as("pa")("POST", `/api/history/capsules/${capsule.id}/recipients`, { userId: USERS.pu[0], type: "student" }), 201);
    const entry = (await owner.query(`INSERT INTO student_history_entries(district_id,school_id,student_id,entry_type,classification,title,occurred_at,audience,status,source_type,author_user_id)
      VALUES($1,$2,$3,'event','official_record','Science fair',now(),'family','published','school',$4) RETURNING id`, [ID.d1, ID.s1, ID.alice, USERS.p1[0]])).rows[0].id;
    ok(await as("pa")("POST", `/api/history/capsules/${capsule.id}/items`, { entryId: entry }), 201);
    ok(await as("pa")("POST", `/api/history/capsules/${capsule.id}/seal`));
    ok(await as("pu")("POST", `/api/history/capsule-invitations/${capsule.id}`, { decision: "approved" }));
    await admin.query("UPDATE student_time_capsules SET release_at=now()-interval '1 minute' WHERE id=$1", [capsule.id]);
    const runtime = new pg.Client(db.appUrl); await runtime.connect();
    try {
      assert.deepEqual((await runtime.query("SELECT outcome FROM eduos_capsule_release_due(100)")).rows.map(r => r.outcome), ["held"]);
      assert.deepEqual((await runtime.query("SELECT outcome FROM eduos_capsule_release_due(100)")).rows.map(r => r.outcome), ["held"], "retried, still held");
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM student_time_capsule_events WHERE capsule_id=$1 AND reason_code='legal_hold'", [capsule.id])).rows[0].n, 1, "logged once a day");

      // Nothing can be withdrawn for deletion.
      await assert.rejects(owner.query("UPDATE student_history_entries SET status='pending_deletion' WHERE id=$1", [entry]), /legal_hold_active/);
      await assert.rejects(owner.query("DELETE FROM student_history_entries WHERE id=$1", [entry]), /legal_hold_active/);

      // A cancelled capsule's photos stay in storage.
      const c2 = ok(await as("pa")("POST", "/api/history/capsules", { studentId: ID.alice, title: "Changed my mind", releaseKind: "scheduled", releaseAt: tomorrow() }), 201);
      const p2 = (await upload("pa", c2.id, await jpeg("#a85"))).body.data.assetId;
      ok(await as("pa")("POST", `/api/history/capsules/${c2.id}/cancel`));
      await new Promise(r => setTimeout(r, 300));
      assert.ok(keyOf(p2), "kept in the bucket");
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM history_preservation_events WHERE asset_id=$1 AND kind='kept_for_hold'", [p2])).rows[0].n, 1);

      // Lifting: superintendent only, with a note.
      assert.equal((await as("p1")("POST", `/api/legal-holds/${hold.id}/release`, { note: "Case closed" })).status, 403);
      assert.equal((await as("supt2")("POST", `/api/legal-holds/${hold.id}/release`, { note: "Case closed" })).status, 404);
      assert.equal((await as("supt1")("POST", `/api/legal-holds/${hold.id}/release`, { note: "x" })).status, 400);
      assert.equal(ok(await as("supt1")("POST", `/api/legal-holds/${hold.id}/release`, { note: "Case dismissed 2026-11-20" })).released, true);
      assert.equal(ok(await as("supt1")("POST", `/api/legal-holds/${hold.id}/release`, { note: "Case dismissed 2026-11-20" })).released, false, "idempotent");
      assert.deepEqual((await runtime.query("SELECT outcome FROM eduos_capsule_release_due(100)")).rows.map(r => r.outcome), ["released"]);
    } finally { await runtime.end(); }
    const audited = (await admin.query("SELECT action FROM audit_events WHERE resource_type='history_legal_hold' ORDER BY occurred_at")).rows.map(r => r.action);
    assert.deepEqual(audited, ["place", "release"]);
  });

  it("the runtime role can't write holds or preservation events directly", async () => {
    const runtime = new pg.Client(db.appUrl); await runtime.connect();
    try {
      await runtime.query("SELECT set_config('app.district_id',$1,false), set_config('app.user_id',$2,false), set_config('app.role','superintendent',false)", [ID.d1, USERS.supt1[0]]);
      await assert.rejects(runtime.query("INSERT INTO history_legal_holds(district_id,school_id,student_id,reason,placed_by) VALUES($1,$2,$3,'sneaky hold',$4)", [ID.d1, ID.s1, ID.alice, USERS.supt1[0]]), /permission denied/);
      await assert.rejects(runtime.query("UPDATE history_legal_holds SET released_at=now()"), /permission denied/);
      await assert.rejects(runtime.query("DELETE FROM history_preservation_events"), /permission denied/);
    } finally { await runtime.end(); }
  });
});
