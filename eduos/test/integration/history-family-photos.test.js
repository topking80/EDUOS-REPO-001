// MEDIA-02: family photos on guardian contributions (TC-02), against real PostgreSQL as the
// runtime role, a mock S3-compatible bucket and a mock clamd. Only the guardian
// who sent a pending memory adds photos; the reviewer sees them; approval puts
// them on the published memory for exactly its audience; a withdrawn or
// rejected memory's photos leave the bucket and stop counting.
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

describe("MEDIA-02 family photos against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s3, clam, clamUp = true, s = {}, item, photoId;
  const objects = new Map(), s3Log = [];
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const jpeg = () => sharp({ create: { width: 1200, height: 900, channels: 3, background: "#58a" } }).jpeg()
    .withMetadata({ exif: { IFD0: { Artist: "Teacher", Copyright: "School" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "39/1 44/1 21/1" } } }).toBuffer();
  const upload = async (who, contribution, body, type = "image/jpeg", { alt = "Alice at the lake", caption = "Summer", key } = {}) => {
    const csrf = (await as(who)("GET", "/api/csrf")).body.csrfToken;
    const r = await fetch(`${server.base}/api/family/children/${ID.alice}/history-contributions/${contribution}/photos?alt=${encodeURIComponent(alt)}&caption=${encodeURIComponent(caption)}`, {
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
      MEDIA_S3_ACCESS_KEY_ID: S3.accessKeyId, MEDIA_S3_SECRET_ACCESS_KEY: S3.secretAccessKey, CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: String(clam.address().port) });
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

  const submit = async (title) => ok(await as("pa")("POST", `/api/family/children/${ID.alice}/history-contributions`, { title, body: "A day to remember", occurredAt: "2026-07-04T15:00:00Z" }), 201);
  const listed = async (who, path) => ok(await as(who)("GET", path));
  const gone = async keyPart => { for (let i = 0; i < 50; i++) { if (![...objects.keys()].some(k => k.includes(keyPart))) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
  let memory;

  it("only the guardian who sent a pending memory adds photos, through the same checks", async () => {
    memory = await submit("Lake day");
    const r = await upload("pa", memory.id, await jpeg(), "image/jpeg", { key: "family-key-001" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    photoId = r.body.data.assetId;
    const stored = [...objects.entries()].find(([k]) => k.includes(photoId));
    assert.ok(stored); assert.equal((await sharp(stored[1].body).metadata()).exif, undefined, "no EXIF or GPS");
    assert.equal((await upload("pa", memory.id, await jpeg(), "image/jpeg", { key: "family-key-001" })).body.data.assetId, photoId, "retries are the same photo");
    for (const who of ["pb", "pu", "p1", "t1"]) assert.equal((await upload(who, memory.id, await jpeg())).status, 404, who);
    const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
    assert.equal((await upload("pa", memory.id, eicar)).body.error, "photo_failed_security_scan");
  });

  it("the guardian and the school's reviewer see it while it's pending; nobody else", async () => {
    assert.equal((await listed("pa", `/api/family/children/${ID.alice}/history-contributions`)).find(c => c.id === memory.id).photos.length, 1);
    assert.equal((await listed("p1", "/api/history-contributions")).find(c => c.id === memory.id).photos[0].alt, "Alice at the lake");
    for (const who of ["pa", "p1", "supt1"]) assert.equal((await photo(who, photoId)).status, 302, who);
    for (const who of ["pb", "pu", "t1", "supt2"]) assert.equal((await photo(who, photoId)).status, 404, who);
  });

  it("approval puts the photos on the published family memory, for exactly its audience", async () => {
    const r = ok(await as("p1")("PATCH", `/api/students/${ID.alice}/history-contributions/${memory.id}`, { decision: "approve" }));
    assert.equal(r.photos, 1);
    const item = (await listed("pa", `/api/history/portfolio?studentId=${ID.alice}`)).items.find(i => i.title === "Lake day");
    assert.deepEqual(item.photos.map(p => [p.alt, p.caption]), [["Alice at the lake", "Summer"]]);
    for (const who of ["pa", "pu"]) assert.equal((await photo(who, photoId)).status, 302, who);
    for (const who of ["pb", "supt2"]) assert.equal((await photo(who, photoId)).status, 404, who);
    assert.equal((await upload("pa", memory.id, await jpeg())).body.error, "contribution_not_editable", "no photos after review");
  });

  it("a withdrawn or rejected memory's photos leave the bucket and stop counting", async () => {
    const w = await submit("Birthday");
    const wp = (await upload("pa", w.id, await jpeg())).body.data.assetId;
    ok(await as("pa")("PATCH", `/api/family/children/${ID.alice}/history-contributions/${w.id}`, { decision: "withdraw" }));
    assert.ok(await gone(wp), "withdrawn: deleted from the bucket");
    assert.equal((await photo("pa", wp)).status, 404);
    const j = await submit("Trip");
    const jp = (await upload("pa", j.id, await jpeg())).body.data.assetId;
    ok(await as("p1")("PATCH", `/api/students/${ID.alice}/history-contributions/${j.id}`, { decision: "reject", note: "Other children in the photo" }));
    assert.ok(await gone(jp), "rejected: deleted from the bucket");
    const counted = (await admin.query("SELECT eduos_history_student_media_bytes($1,$2) AS n", [ID.d1, ID.alice])).rows[0].n;
    const kept = [...objects.values()].reduce((t, o) => t + o.body.length, 0);
    assert.equal(Number(counted), kept, "only the published photo counts toward the student's total");
  });

  it("a custody restriction stops the guardian's photos too", async () => {
    const c = await submit("Pumpkin patch");
    ok(await as("p1")("POST", `/api/students/${ID.alice}/custody-restrictions`, { userId: USERS.pa[0], kind: "court_order", basis: "Order 2026-200 received" }), 201);
    assert.equal((await upload("pa", c.id, await jpeg())).status, 404);
    assert.equal((await photo("pa", photoId)).status, 404, "nor see the published one");
  });
});
