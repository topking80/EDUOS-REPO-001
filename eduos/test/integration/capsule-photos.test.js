// MEDIA-03: photos in Time Capsules, against real PostgreSQL as the runtime
// role, a mock S3-compatible bucket and a mock clamd. The owner adds their own
// photos to a draft; photos on the items inside come along; recipients see
// nothing until the capsule is released to them; sealing stops changes;
// cancelling deletes the owner's photos.
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
// Throwaway credentials for the mock bucket, made fresh for each run.
const S3 = { region: "us-east-1", accessKeyId: `TEST${crypto.randomBytes(6).toString("hex").toUpperCase()}`, secretAccessKey: crypto.randomBytes(24).toString("base64url"), bucket: "eduos-media" };

describe("MEDIA-03 Time Capsule photos against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s3, clam, clamUp = true, s = {}, item, photoId;
  const objects = new Map(), s3Log = [];
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const jpeg = () => sharp({ create: { width: 1200, height: 900, channels: 3, background: "#58a" } }).jpeg()
    .withMetadata({ exif: { IFD0: { Artist: "Teacher", Copyright: "School" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "39/1 44/1 21/1" } } }).toBuffer();
  const upload = async (who, contribution, body, type = "image/jpeg", { alt = "Alice at the lake", caption = "Summer", key } = {}) => {
    const csrf = (await as(who)("GET", "/api/csrf")).body.csrfToken;
    const r = await fetch(`${server.base}/api/history/capsules/${contribution}/photos?alt=${encodeURIComponent(alt)}&caption=${encodeURIComponent(caption)}`, {
      method: "POST", body, headers: { cookie: s[who].cookie, "content-type": type, "x-csrf-token": csrf, ...(key ? { "idempotency-key": key } : {}) } });
    return { status: r.status, body: await r.json() };
  };
  const photo = async (who, id) => fetch(`${server.base}/api/history/photos/${id}`, { headers: { cookie: s[who].cookie }, redirect: "manual" });

  before(async () => {
    // A private S3-compatible bucket that verifies SigV4 on every request.
    s3 = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x"), chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        const host = req.headers.host, path = decodeURIComponent(u.pathname), q = Object.fromEntries(u.searchParams);
        let valid = false;
        if (q["X-Amz-Signature"]) {
          const { "X-Amz-Signature": sig, "X-Amz-Algorithm": _a, "X-Amz-Credential": _c, "X-Amz-Date": d, "X-Amz-Expires": exp, "X-Amz-SignedHeaders": _sh, ...rest } = q;
          const date = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
          valid = signS3({ method: req.method, host, path, query: rest, ...S3, date, presign: Number(exp) }).signature === sig && Date.now() < date.getTime() + Number(exp) * 1000;
        } else if (req.headers.authorization) {
          const d = req.headers["x-amz-date"], signed = /SignedHeaders=([^,]+)/.exec(req.headers.authorization)[1].split(";");
          const headers = Object.fromEntries(signed.filter(h => !["host", "x-amz-date", "x-amz-content-sha256"].includes(h)).map(h => [h, req.headers[h]]));
          const date = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
          valid = signS3({ method: req.method, host, path, headers, ...S3, date, payloadHash: req.headers["x-amz-content-sha256"] }).signature === /Signature=([0-9a-f]+)/.exec(req.headers.authorization)[1];
        }
        s3Log.push({ method: req.method, path, valid, presigned: Boolean(q["X-Amz-Signature"]) });
        if (!valid) { res.writeHead(403); return res.end("SignatureDoesNotMatch"); }
        if (req.method === "PUT") { objects.set(path, { body: Buffer.concat(chunks), type: req.headers["content-type"] }); res.writeHead(200); return res.end(); }
        const o = objects.get(path);
        if (!o) { res.writeHead(404); return res.end(); }
        if (req.method === "DELETE") { objects.delete(path); res.writeHead(204); return res.end(); }
        res.writeHead(200, { "content-type": o.type, "content-length": o.body.length }); res.end(req.method === "HEAD" ? undefined : o.body);
      });
    });
    await new Promise(r => s3.listen(0, "127.0.0.1", r));
    clam = net.createServer(sock => { let buf = Buffer.alloc(0);
      sock.on("data", d => { buf = Buffer.concat([buf, d]); if (buf.length >= 14 && buf.subarray(-4).equals(Buffer.alloc(4)))
        sock.end(!clamUp ? "INSTREAM size limit exceeded. ERROR\0" : buf.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE") ? "stream: Eicar-Signature FOUND\0" : "stream: OK\0"); }); });
    await new Promise(r => clam.listen(0, "127.0.0.1", r));

    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app,
      MEDIA_S3_ENDPOINT: `http://127.0.0.1:${s3.address().port}`, MEDIA_S3_REGION: S3.region, MEDIA_S3_BUCKET: S3.bucket, MEDIA_S3_PATH_STYLE: "true",
      CAPSULE_RELEASE_INTERVAL_SECONDS: "0", MEDIA_S3_ACCESS_KEY_ID: S3.accessKeyId, MEDIA_S3_SECRET_ACCESS_KEY: S3.secretAccessKey, CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: String(clam.address().port) });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$3)", [ID.d1, ID.s1, USERS.t1[0], ID.alice]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["t1", "p1", "supt1", "supt2", "pa", "pb", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    ok(await as("supt1")("PUT", "/api/history/media-policy", { imagesEnabled: true, maxImageBytes: 5 * 1048576, maxPerEntry: 3, maxBytesPerStudent: 50 * 1048576 }));
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); s3?.close(); clam?.close(); });

  const tomorrow = () => new Date(Date.now() + 86400000).toISOString();
  const gone = async keyPart => { for (let i = 0; i < 80; i++) { if (![...objects.keys()].some(k => k.includes(keyPart))) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
  let capsule, memoryPhoto;

  it("the owner adds their own photo to a draft capsule; photos on the items inside come along", async () => {
    // A published family memory with a photo (MEDIA-02).
    const m = ok(await as("pa")("POST", `/api/family/children/${ID.alice}/history-contributions`, { title: "First bike", body: "No training wheels!", occurredAt: "2026-05-01T15:00:00Z" }), 201);
    const csrf = (await as("pa")("GET", "/api/csrf")).body.csrfToken;
    memoryPhoto = (await (await fetch(`${server.base}/api/family/children/${ID.alice}/history-contributions/${m.id}/photos?alt=${encodeURIComponent("Alice on her bike")}`, {
      method: "POST", body: await jpeg(), headers: { cookie: s.pa.cookie, "content-type": "image/jpeg", "x-csrf-token": csrf } })).json()).data.assetId;
    const approved = ok(await as("p1")("PATCH", `/api/students/${ID.alice}/history-contributions/${m.id}`, { decision: "approve" }));
    capsule = ok(await as("pa")("POST", "/api/history/capsules", { studentId: ID.alice, title: "For Alice at 18", message: "Look how you've grown.", releaseKind: "scheduled", releaseAt: tomorrow(), timezone: "America/New_York" }), 201);
    ok(await as("pa")("POST", `/api/history/capsules/${capsule.id}/items`, { entryId: approved.history_entry_id }), 201);
    const r = await upload("pa", capsule.id, await jpeg(), "image/jpeg", { alt: "Our family on the porch", caption: "Spring 2026", key: "capsule-key-01" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    photoId = r.body.data.assetId;
    assert.equal((await sharp([...objects.entries()].find(([k]) => k.includes(photoId))[1].body).metadata()).exif, undefined, "no EXIF or GPS");
    const mine = ok(await as("pa")("GET", `/api/history/capsules/${capsule.id}`));
    assert.deepEqual(mine.photos.map(p => p.alt), ["Our family on the porch"]);
    assert.deepEqual(mine.items[0].photos.map(p => p.alt), ["Alice on her bike"]);
    for (const who of ["pb", "pu", "p1", "t1"]) assert.equal((await upload(who, capsule.id, await jpeg())).status, 404, who);
  });

  it("recipients see nothing until it's released to them", async () => {
    ok(await as("pa")("POST", `/api/history/capsules/${capsule.id}/recipients`, { userId: USERS.pu[0], type: "student" }), 201);
    ok(await as("pa")("POST", `/api/history/capsules/${capsule.id}/seal`));
    assert.equal((await upload("pa", capsule.id, await jpeg())).body.error, "capsule_not_a_draft", "sealed: no changes");
    assert.equal((await photo("pa", photoId)).status, 302, "the owner still can");
    for (const who of ["pu", "pb", "supt2"]) assert.equal((await photo(who, photoId)).status, 404, `${who} before release`);
    ok(await as("pu")("POST", `/api/history/capsule-invitations/${capsule.id}`, { decision: "approved" }));
    assert.equal((await photo("pu", photoId)).status, 404, "accepted but not yet released");
    await admin.query("UPDATE student_time_capsules SET release_at=now()-interval '1 minute' WHERE id=$1", [capsule.id]);
    const runtime = new pg.Client(db.appUrl); await runtime.connect();
    assert.deepEqual((await runtime.query("SELECT outcome FROM eduos_capsule_release_due(100)")).rows.map(r => r.outcome), ["released"]);
    await runtime.end();
    const opened = ok(await as("pu")("GET", `/api/history/capsules/${capsule.id}`));
    assert.deepEqual(opened.photos.map(p => [p.alt, p.caption]), [["Our family on the porch", "Spring 2026"]]);
    assert.deepEqual(opened.items[0].photos.map(p => p.alt), ["Alice on her bike"]);
    for (const id of [photoId, memoryPhoto]) assert.equal((await photo("pu", id)).status, 302);
    for (const who of ["pb", "supt2"]) assert.equal((await photo(who, photoId)).status, 404, who);
  });

  it("cancelling a capsule deletes the owner's photos (not the history's)", async () => {
    const c = ok(await as("pa")("POST", "/api/history/capsules", { studentId: ID.alice, title: "Never mind", releaseKind: "scheduled", releaseAt: tomorrow() }), 201);
    const p = (await upload("pa", c.id, await jpeg())).body.data.assetId;
    ok(await as("pa")("POST", `/api/history/capsules/${c.id}/cancel`));
    assert.ok(await gone(p), "deleted from the bucket");
    assert.equal((await photo("pa", p)).status, 404);
    assert.ok([...objects.keys()].some(k => k.includes(memoryPhoto)), "the family memory's photo stays");
  });
});
