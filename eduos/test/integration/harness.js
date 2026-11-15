// Real-PostgreSQL integration harness (32.0.53).
// Enabled when EDUOS_TEST_PG_URL points at a PostgreSQL 15+ superuser
// connection, e.g. postgres://postgres@127.0.0.1:5432/postgres. A throw-away
// database plus non-superuser owner and runtime roles are created per run and
// dropped afterwards. Without the variable every integration test is skipped.
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

export const PG_URL = process.env.EDUOS_TEST_PG_URL || "";
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const ID = {
  d1: "d1000000-0000-4000-8000-000000000001", d2: "d2000000-0000-4000-8000-000000000002",
  s1: "51000000-0000-4000-8000-000000000001", s2: "52000000-0000-4000-8000-000000000002",
  sd2: "5d200000-0000-4000-8000-000000000003",
  alice: "b0000000-0000-4000-8000-00000000000a", bob: "b0000000-0000-4000-8000-00000000000b",
  carol: "b0000000-0000-4000-8000-00000000000c", xavier: "b0000000-0000-4000-8000-00000000000d",
  draft: "c0000000-0000-4000-8000-000000000001"
};
// name -> [user id, display, email, memberships [district, school, role, default]]
export const USERS = {
  supt1: ["a0000000-0000-4000-8000-000000000001", "Supt One", "supt1@d1.test", [["d1", null, "superintendent", true]]],
  supt1b: ["a0000000-0000-4000-8000-000000000002", "Supt Two", "supt1b@d1.test", [["d1", null, "superintendent", true]]],
  p1: ["a0000000-0000-4000-8000-000000000003", "Principal S1", "p1@d1.test", [["d1", "s1", "principal", true]]],
  p2: ["a0000000-0000-4000-8000-000000000004", "Principal S2", "p2@d1.test", [["d1", "s2", "principal", true]]],
  t1: ["a0000000-0000-4000-8000-000000000005", "Teacher S1", "t1@d1.test", [["d1", "s1", "teacher", true]]],
  pa: ["a0000000-0000-4000-8000-000000000006", "Parent A", "parent.a@d1.test", [["d1", "s1", "parent", true]]],
  pu: ["a0000000-0000-4000-8000-000000000007", "Pupil A", "pupil.a@d1.test", [["d1", "s1", "pupil", true]]],
  supt2: ["a0000000-0000-4000-8000-000000000008", "Supt D2", "supt2@d2.test", [["d2", null, "superintendent", true]]],
  pb: ["a0000000-0000-4000-8000-000000000009", "Parent Bob", "parent.bob@d1.test", [["d1", "s1", "parent", true]]],
  // Staff member who is also a parent (finding 24).
  tp: ["a0000000-0000-4000-8000-00000000000a", "Teacher Parent", "tp@d1.test", [["d1", "s1", "teacher", true], ["d1", "s1", "parent", false]]],
  // Parent with children at two schools (finding 24).
  p2s: ["a0000000-0000-4000-8000-00000000000b", "Two-School Parent", "two.school@d1.test", [["d1", "s1", "parent", true], ["d1", "s2", "parent", false]]],
  vp1: ["a0000000-0000-4000-8000-00000000000c", "Vice Principal S1", "vp1@d1.test", [["d1", "s1", "vice_principal", true]]]
};

export async function startIdp() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, idp.issuer);
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/.well-known/openid-configuration")
      return send(200, { issuer: idp.issuer, authorization_endpoint: `${idp.issuer}/authorize`, token_endpoint: `${idp.issuer}/token`, jwks_uri: `${idp.issuer}/jwks` });
    if (url.pathname === "/jwks") return send(200, { keys: [jwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const claims = codes.get(new URLSearchParams(raw).get("code"));
      if (!claims) return send(400, { error: "invalid_grant" });
      const idToken = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(idp.issuer).setAudience("eduos-it").setIssuedAt().setExpirationTime("5m").sign(privateKey);
      return send(200, { id_token: idToken, token_type: "Bearer" });
    }
    send(404, { error: "not_found" });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const idp = { issuer: `http://127.0.0.1:${server.address().port}`, codes, close: () => new Promise(r => server.close(r)) };
  return idp;
}

export function baseEnv(extra = {}) {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development",
    PUBLIC_ORIGIN: "http://localhost", OIDC_ISSUER: "http://127.0.0.1:9", OIDC_CLIENT_ID: "eduos-it",
    OIDC_CLIENT_SECRET: "it-secret", OIDC_REDIRECT_URI: "http://localhost/auth/callback", ...extra
  };
}

export function run(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env });
    let out = ""; child.stdout.on("data", d => out += d); child.stderr.on("data", d => out += d);
    child.on("exit", code => resolve({ code, out }));
  });
}

export async function createDatabase() {
  const suffix = crypto.randomBytes(4).toString("hex");
  const names = { db: `eduos_it_${suffix}`, owner: `eduos_it_owner_${suffix}`, app: `eduos_it_app_${suffix}` };
  const pw = { owner: `owner-${suffix}-pw`, app: `app-${suffix}-pw` };
  const admin = new pg.Client(PG_URL); await admin.connect();
  await admin.query(`CREATE ROLE ${names.owner} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${pw.owner}'`);
  await admin.query(`CREATE ROLE ${names.app} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${pw.app}'`);
  await admin.query(`CREATE DATABASE ${names.db} OWNER ${names.owner}`);
  await admin.end();
  const u = new URL(PG_URL);
  const url = (user, pass) => { const x = new URL(u); x.username = user; x.password = pass; x.pathname = `/${names.db}`; return x.toString(); };
  const adminUrl = (() => { const x = new URL(u); x.pathname = `/${names.db}`; return x.toString(); })();
  return {
    names, ownerUrl: url(names.owner, pw.owner), appUrl: url(names.app, pw.app), adminUrl,
    async drop() {
      const c = new pg.Client(PG_URL); await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${names.db} WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS ${names.app}`); await c.query(`DROP ROLE IF EXISTS ${names.owner}`);
      await c.end();
    }
  };
}

export async function seed(adminUrl, issuer) {
  const c = new pg.Client(adminUrl); await c.connect();
  const q = (sql, params) => c.query(sql, params);
  await q(`INSERT INTO districts(id,name) VALUES ($1,'D1'),($2,'D2')`, [ID.d1, ID.d2]);
  await q(`INSERT INTO schools(id,district_id,name) VALUES ($1,$4,'S1'),($2,$4,'S2'),($3,$5,'D2-S')`, [ID.s1, ID.s2, ID.sd2, ID.d1, ID.d2]);
  for (const [sub, [id, name, email, memberships]] of Object.entries(USERS)) {
    await q(`INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES ($1,$2,$3,$4,$5)`, [id, issuer, sub, name, email]);
    for (const [d, s, role, isDefault] of memberships)
      await q(`INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES ($1,$2,$3,$4,$5)`, [id, ID[d], s ? ID[s] : null, role, isDefault]);
  }
  await q(`INSERT INTO students(id,district_id,school_id,local_student_number,display_name,grade_level) VALUES
    ($1,$5,$7,'S1-A','Alice A','3'),($2,$5,$7,'S1-B','Bob B','3'),($3,$5,$8,'S2-C','Carol C','5'),($4,$6,$9,'D2-X','Xavier X','4')`,
    [ID.alice, ID.bob, ID.carol, ID.xavier, ID.d1, ID.d2, ID.s1, ID.s2, ID.sd2]);
  await q(`INSERT INTO student_user_links(district_id,user_id,student_id,relationship) VALUES
    ($1,$2,$3,'parent'),($1,$4,$3,'pupil'),($1,$5,$6,'parent'),($1,$7,$3,'parent')`,
    [ID.d1, USERS.pa[0], ID.alice, USERS.pu[0], USERS.pb[0], ID.bob, USERS.tp[0]]);
  await q(`INSERT INTO assignments(id,district_id,school_id,created_by,title,instructions,status) VALUES
    ($1,$2,$3,$4,'DRAFT secret quiz','answer key: 42','draft'),
    (gen_random_uuid(),$2,$3,$4,'Published reading','read ch.1','published')`, [ID.draft, ID.d1, ID.s1, USERS.t1[0]]);
  await c.end();
}

export async function freePort() {
  const s = http.createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r));
  const { port } = s.address(); await new Promise(r => s.close(r)); return port;
}

export async function startServer(env) {
  const child = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, env: { ...env, PORT: String(await freePort()) } });
  let out = "";
  const port = await new Promise((resolve, reject) => {
    const onData = d => { out += d; const m = /listening on (\d+)/.exec(out); if (m) resolve(Number(m[1])); };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.on("exit", code => reject(new Error(`server exited (${code}): ${out}`)));
  });
  servers.push({ log: () => out });
  return { base: `http://127.0.0.1:${port}`, child, log: () => out, stop: () => new Promise(r => { if (child.exitCode !== null || child.signalCode !== null) return r(); child.removeAllListeners("exit"); child.on("exit", r); child.kill(); }) };
}

// express-rate-limit logs (rather than throws) when a limiter is misconfigured,
// for example a custom key that uses req.ip directly. Every integration file
// imports this harness, so this file-level hook (after the suite's own cleanup)
// fails the run if any server it started logged such an error.
const servers = [];
after(() => {
  const bad = servers.flatMap(s => s.log().split("\n").filter(l => /ERR_ERL_[A-Z_]+/.test(l)));
  assert.deepEqual(bad, [], "the server logged rate-limiter validation errors");
});

const cookieName = "eduos_session";
const pickCookie = (res, prefix) => res.headers.getSetCookie().map(c => c.split(";")[0]).find(c => c.startsWith(prefix) && !c.endsWith("="));

/** Full OIDC authorization-code login against the mock IdP. */
export async function login(base, idp, sub, extraClaims = {}, previousCookie = null) {
  const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
  if (start.status !== 302) throw new Error(`login start ${start.status}: ${await start.text()}`);
  const location = new URL(start.headers.get("location"));
  const state = location.searchParams.get("state"), nonce = location.searchParams.get("nonce");
  const stateCookie = pickCookie(start, "eduos_oidc_state_");
  const code = crypto.randomBytes(12).toString("hex");
  const email = USERS[sub]?.[2];
  idp.codes.set(code, { sub, nonce, email, ...extraClaims });
  const cb = await fetch(`${base}/auth/callback?code=${code}&state=${encodeURIComponent(state)}`, {
    redirect: "manual", headers: { cookie: [stateCookie, previousCookie].filter(Boolean).join("; ") }
  });
  const cookie = pickCookie(cb, `${cookieName}=`);
  if (cb.status !== 303 || !cookie) return { status: cb.status, body: await cb.text() };
  const csrf = (await (await fetch(`${base}/api/csrf`, { headers: { cookie } })).json()).csrfToken;
  return { status: cb.status, cookie, csrf, state };
}

export function client(base, session) {
  return async (method, path, body) => {
    const headers = { cookie: session.cookie };
    if (method !== "GET") headers["x-csrf-token"] = session.csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json ?? text, headers: res.headers };
  };
}
