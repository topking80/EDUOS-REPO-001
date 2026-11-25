// MEDIA-01: photos on student history items, against real PostgreSQL as the
// runtime role, a mock S3-compatible bucket (which checks every signature)
// and a mock clamd. Off until the superintendent turns photos on; every photo
// is scanned, decoded, re-encoded without EXIF/GPS and scanned again before
// only the processed file is stored; malware and mislabeled files are refused;
// limits hold; nobody sees a photo they couldn't see the item for; links last
// 60 seconds; a scanner outage fails closed.
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

describe("MEDIA-01 history photos against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s3, clam, clamUp = true, s = {}, item, photoId;
  const objects = new Map(), s3Log = [];
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const jpeg = () => sharp({ create: { width: 1200, height: 900, channels: 3, background: "#58a" } }).jpeg()
    .withMetadata({ exif: { IFD0: { Artist: "Teacher", Copyright: "School" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "39/1 44/1 21/1" } } }).toBuffer();
  const upload = async (who, entry, body, type = "image/jpeg", { alt = "Volcano model erupting", caption = "Science fair", key } = {}) => {
    const csrf = (await as(who)("GET", "/api/csrf")).body.csrfToken;
    const r = await fetch(`${server.base}/api/history/entries/${entry}/photos?alt=${encodeURIComponent(alt)}&caption=${encodeURIComponent(caption)}`, {
      method: "POST", body, headers: { cookie: s[who].cookie, "content-type": type, "x-csrf-token": csrf, ...(key ? { "idempotency-key": key } : {}) } });
    return { status: r.status, body: await r.json() };
  };
  const photo = async (who, id) => fetch(`${server.base}/api/history/photos/${id}`, { headers: { cookie: s[who].cookie }, redirect: "manual" });
  const uploadDocument = async (who, studentId, contributionId, body, name = "family-note.txt", key) => {
    const csrf = (await as(who)("GET", "/api/csrf")).body.csrfToken;
    const url = `${server.base}/api/family/children/${studentId}/history-contributions/${contributionId}/documents?name=${encodeURIComponent(name)}`;
    const r = await fetch(url, { method: "POST", body, headers: { cookie: s[who].cookie,
      "content-type": "text/plain; charset=utf-8", "x-csrf-token": csrf, ...(key ? { "idempotency-key": key } : {}) } });
    return { status: r.status, body: await r.json() };
  };

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
    item = ok(await as("t1")("POST", `/api/students/${ID.alice}/history/teacher-items`, { title: "Volcano project", body: "Built a working volcano.", occurredAt: "2026-10-15T15:00:00Z", entryType: "project" }), 201);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); s3?.close(); clam?.close(); });

  it("off until the superintendent turns photos on", async () => {
    assert.equal((await upload("t1", item.id, await jpeg())).body.error, "photos_not_enabled");
    const p = ok(await as("t1")("GET", "/api/history/media-policy"));
    assert.equal(p.imagesEnabled, false); assert.equal(p.storageReady, true); assert.equal(p.canEdit, false);
    const body = { imagesEnabled: true, maxImageBytes: 5 * 1048576, maxPerEntry: 2, maxBytesPerStudent: 50 * 1048576 };
    assert.equal((await as("p1")("PUT", "/api/history/media-policy", body)).status, 403);
    ok(await as("supt1")("PUT", "/api/history/media-policy", body));
  });

  it("a photo is scanned, re-encoded without EXIF/GPS, scanned again, and only that copy is stored", async () => {
    const r = await upload("t1", item.id, await jpeg(), "image/jpeg", { key: "retry-key-0001" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    photoId = r.body.data.assetId;
    const stored = [...objects.entries()];
    assert.equal(stored.length, 1, "only the processed photo");
    assert.match(stored[0][0], new RegExp(`^/${S3.bucket}/history/${ID.d1}/${ID.alice}/${photoId}\\.jpeg$`));
    const m = await sharp(stored[0][1].body).metadata();
    assert.equal(m.format, "jpeg"); assert.equal(m.exif, undefined, "no EXIF or GPS");
    assert.ok(s3Log.every(l => l.valid), "every storage request was signed correctly");
    const again = await upload("t1", item.id, await jpeg(), "image/jpeg", { key: "retry-key-0001" });
    assert.equal(again.status, 200); assert.equal(again.body.data.assetId, photoId, "a retry with the same key is the same photo");
  });

  it("malware, mislabeled files, missing descriptions and the district's limits are refused", async () => {
    const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
    assert.equal((await upload("t1", item.id, eicar)).body.error, "photo_failed_security_scan");
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#000" } }).png().toBuffer();
    assert.equal((await upload("t1", item.id, png, "image/jpeg")).body.error, "image_type_mismatch");
    assert.equal((await upload("t1", item.id, png, "image/gif")).status, 415);
    assert.equal((await upload("t1", item.id, png, "image/png", { alt: "" })).body.error, "describe_the_photo");
    assert.equal(objects.size, 1, "nothing else was stored");
    ok(await upload("t1", item.id, png, "image/png").then(r => ({ status: r.status, body: r.body })), 201);
    assert.equal((await upload("t1", item.id, png, "image/png")).body.error, "too_many_photos", "two per item (the failed ones don't count)");
  });

  it("only someone who can change the item adds photos; nobody sees one they couldn't see the item for", async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#000" } }).png().toBuffer();
    for (const who of ["pa", "pb", "pu", "supt2"]) assert.equal((await upload(who, item.id, png, "image/png")).status, 404, who);
    assert.equal((await upload("p1", item.id, png, "image/png")).body.error, "too_many_photos", "the school's leader may (school items), within the limits");
    assert.equal((await photo("t1", photoId)).status, 302, "the teacher sees their own draft's photo");
    for (const who of ["pa", "pu", "pb", "supt2"]) assert.equal((await photo(who, photoId)).status, 404, `${who} before it's published`);
  });

  it("once published, the family sees it through a signed 60-second link; others still can't", async () => {
    ok(await as("p1")("POST", `/api/history-review/${item.id}`, { decision: "approve" }));
    ok(await as("pa")("POST", `/api/family/children/${ID.alice}/history-items/${item.id}`, { decision: "accept" }));
    const port = ok(await as("pa")("GET", `/api/history/portfolio?studentId=${ID.alice}`)).items.find(i => i.id === item.id);
    assert.deepEqual(port.photos.map(p => [p.alt, p.caption]), [["Volcano model erupting", "Science fair"], ["Volcano model erupting", "Science fair"]]);
    const r = await photo("pa", photoId);
    assert.equal(r.status, 302); assert.equal(r.headers.get("cache-control"), "no-store");
    const link = new URL(r.headers.get("location"));
    assert.equal(link.searchParams.get("X-Amz-Expires"), "60");
    assert.ok(!link.href.includes(S3.secretAccessKey));
    const img = await fetch(link); assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/jpeg");
    const tampered = new URL(link); tampered.pathname = tampered.pathname.replace(photoId, "00000000-0000-4000-8000-000000000000");
    assert.equal((await fetch(tampered)).status, 403, "a changed link fails its signature");
    for (const who of ["pb", "supt2"]) assert.equal((await photo(who, photoId)).status, 404, who);
    const exp = await fetch(`${server.base}/api/history/export?format=json&studentId=${ID.alice}`, { headers: { cookie: s.pa.cookie } }).then(x => x.json());
    assert.deepEqual(exp.items.find(i => i.title === "Volcano project").photos[0], { caption: "Science fair", description: "Volcano model erupting" });
  });

  it("published items take no new photos; a scanner outage fails closed", async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#000" } }).png().toBuffer();
    assert.equal((await upload("t1", item.id, png, "image/png")).body.error, "entry_not_editable");
    const other = ok(await as("t1")("POST", `/api/students/${ID.alice}/history/teacher-items`, { title: "Poem", body: "", occurredAt: "2026-10-20T15:00:00Z", entryType: "project" }), 201);
    clamUp = false;
    assert.equal((await upload("t1", other.id, png, "image/png")).body.error, "security_scan_unavailable");
    clamUp = true;
    assert.equal(ok(await as("t1")("GET", "/api/teacher/history-items")).find(i => i.id === other.id).photos.length, 0);
  });

  it("guardian text documents are district-controlled, scanned, private attachments and released on rejection", async () => {
    const contribution = ok(await as("pa")("POST", `/api/family/children/${ID.alice}/history-contributions`, {
      title: "Family letter", body: "A note for the portfolio.", occurredAt: "2026-10-21T15:00:00Z"
    }), 201);
    const text = Buffer.from("A family memory.\nWritten in UTF-8.\n", "utf8");
    assert.equal((await uploadDocument("pa", ID.alice, contribution.id, text)).body.error, "documents_not_enabled");
    ok(await as("supt1")("PUT", "/api/history/document-policy", {
      documentsEnabled: true, maxDocumentBytes: 10240, maxDocumentsPerContribution: 2
    }));
    const uploaded = await uploadDocument("pa", ID.alice, contribution.id, text, "family-letter.txt", "doc-retry-0001");
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const asset = uploaded.body.data.assetId;
    const checksum = (await admin.query("SELECT sha256, integrity_status FROM private_media_objects WHERE asset_id=$1", [asset])).rows[0];
    assert.match(checksum.sha256, /^[0-9a-f]{64}$/);
    assert.equal(checksum.integrity_status, "ok", "documents enter the TC-08 integrity registry");
    const again = await uploadDocument("pa", ID.alice, contribution.id, text, "family-letter.txt", "doc-retry-0001");
    assert.equal(again.status, 200); assert.equal(again.body.data.assetId, asset, "idempotent retry");
    clamUp = false;
    assert.equal((await uploadDocument("pa", ID.alice, contribution.id, Buffer.from("Scanner outage"), "outage.txt")).body.error, "security_scan_unavailable");
    clamUp = true;
    const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
    assert.equal((await uploadDocument("pa", ID.alice, contribution.id, eicar, "infected.txt")).body.error, "document_failed_security_scan");
    const second = await uploadDocument("pa", ID.alice, contribution.id, Buffer.from("Second note"), "second.txt");
    assert.equal(second.status, 201);
    assert.equal((await uploadDocument("pa", ID.alice, contribution.id, Buffer.from("Third note"), "third.txt")).body.error, "too_many_documents");
    assert.equal((await uploadDocument("pa", ID.alice, contribution.id, text, "not-a-pdf.pdf")).body.error, "invalid_document_name");
    const familyList = ok(await as("pa")("GET", `/api/family/children/${ID.alice}/history-contributions`));
    assert.equal(familyList.find(c => c.id === contribution.id).documents.length, 2);
    assert.equal(familyList.find(c => c.id === contribution.id).documents[0].id, asset);
    const reviewerList = ok(await as("p1")("GET", "/api/history-contributions"));
    assert.equal(reviewerList.find(c => c.id === contribution.id).documents[0].fileName, "family-letter.txt");
    const storage = ok(await as("pa")("GET", `/api/history/storage?studentId=${ID.alice}`));
    assert.ok(storage.usage.usedBytes >= text.length, "family storage total includes document bytes");
    assert.deepEqual(storage.limits.documentTypes, ["text/plain; charset=utf-8"]);
    assert.equal((await fetch(`${server.base}/api/history/documents/${asset}`, { headers: { cookie: s.pb.cookie } })).status, 404);
    const download = await fetch(`${server.base}/api/history/documents/${asset}`, { headers: { cookie: s.pa.cookie } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(download.headers.get("content-disposition"), /attachment; filename="family-letter.txt"/);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.equal(Buffer.from(await download.arrayBuffer()).toString("utf8"), text.toString("utf8"));
    assert.equal((await uploadDocument("pa", ID.alice, contribution.id, Buffer.from([0xff,0xfe]), "bad.txt")).body.error, "invalid_utf8_text");
    const rejected = ok(await as("p1")("PATCH", `/api/students/${ID.alice}/history-contributions/${contribution.id}`, { decision: "reject", note: "Not for publication" }));
    assert.equal(rejected.status, "rejected");
    assert.equal(objects.has(`/${S3.bucket}/history/${ID.d1}/${ID.alice}/${asset}.txt`), false, "rejected document object is deleted");
    assert.equal((await fetch(`${server.base}/api/history/documents/${asset}`, { headers: { cookie: s.pa.cookie } })).status, 404);

    const approvedContribution = ok(await as("pa")("POST", `/api/family/children/${ID.alice}/history-contributions`, {
      title: "Grandparent story", body: "A story to keep.", occurredAt: "2026-10-22T15:00:00Z"
    }), 201);
    const approvedUpload = await uploadDocument("pa", ID.alice, approvedContribution.id, Buffer.from("A story preserved."), "story.txt");
    assert.equal(approvedUpload.status, 201, JSON.stringify(approvedUpload.body));
    const review = ok(await as("p1")("PATCH", `/api/students/${ID.alice}/history-contributions/${approvedContribution.id}`, { decision: "approve" }));
    assert.equal(review.status, "approved");
    ok(await as("pa")("POST", `/api/family/children/${ID.alice}/history-items/${review.history_entry_id}`, { decision: "accept" }));
    const portfolio = ok(await as("pa")("GET", `/api/history/portfolio?studentId=${ID.alice}`));
    const memory = portfolio.items.find(i => i.id === review.history_entry_id);
    assert.equal(memory.documents[0].fileName, "story.txt", "approved document appears in the authorized history portfolio");
    const familyDownload = await fetch(`${server.base}${memory.documents[0].href}`, { headers: { cookie: s.pa.cookie } });
    assert.equal(familyDownload.status, 200);
    assert.equal(Buffer.from(await familyDownload.arrayBuffer()).toString("utf8"), "A story preserved.");
    const exportResponse = await fetch(`${server.base}/api/history/export?format=json&studentId=${ID.alice}`, { headers: { cookie: s.pa.cookie } });
    assert.equal(exportResponse.status, 200);
    const exportDoc = await exportResponse.json();
    assert.equal(exportDoc.items.find(i => i.title === "Grandparent story").documents[0].fileName, "story.txt");

    ok(await as("supt1")("PUT", "/api/history/document-policy", {
      documentsEnabled: false, maxDocumentBytes: 10240, maxDocumentsPerContribution: 2
    }));
  });
});
