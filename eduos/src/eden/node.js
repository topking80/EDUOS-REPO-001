import { readFileSync } from "node:fs";
// EduOS 32.7.0 school node (EDUOS_NODE_TIER=school).
// The node is a full EduOS for ONE school, on the school's own network (a
// Pi 5-class box is the target profile). It keeps working when the uplink is
// down: every role app reads and writes the local database. The EDEN agent
// below syncs when the link is up:
//   up   : gated aggregates (src/eden/egress.js), heartbeat, sealed DECN packages
//   down : district-signed bundles (catalog, branding, lessons, content)
// and runs DECN for a partner school when the district authorizes it.
import os from "node:os";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { withTenantTransaction } from "../db.js";
import { requireSession, requireCsrf, addSessionGuard } from "../auth.js";
import { requirePermission } from "../policy.js";
import { release, releaseConsented, GateError } from "./aggregation-gate.js";
import { generateIdentityKeys, proofOfPossession, verifyCertificate, verifyBundle, seal, open, canonical, sha256, certificateFingerprint } from "./crypto.js";
import { queueRelease, flushOutbox, sendControl, download, sendSealed, loadIdentifiers, logBlocked } from "./egress.js";
import { pinnedRoot, loadNodeIdentity, saveNodeIdentity, withSystem, hubPost, APP_VERSION } from "./runtime.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AGGREGATE_KINDS = ["enrollment_by_grade", "attendance_daily", "mastery_by_standard", "transport_checkins_daily", "gradebook_distribution", "safety_summary"];
const DAILY = new Set(["attendance_daily", "transport_checkins_daily", "safety_summary"]);
const CONTINUITY_REFRESH_MS = 60 * 60_000;
// Services a hosted school's staff may use on a partner node during failover.
const HOSTED_ALLOW = [/^\/api\/(me|csrf|memberships|app-config|home|notifications)(\/|$)/, /^\/api\/session\/membership$/, /^\/api\/branding(\/|$)/,
  /^\/api\/safety(\/|$)/, /^\/api\/pickup(\/|$)/, /^\/api\/transport(\/|$)/, /^\/api\/attendance$/, /^\/api\/students$/, /^\/api\/schools$/, /^\/api\/node\/hosting$/];

// Container memory limit (cgroup v2, then v1), so the IT screen shows the real budget.
function cgroupLimitMb() {
  for (const f of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try { const v = Number(readFileSync(f, "utf8").trim()); if (Number.isFinite(v) && v > 0 && v < os.totalmem()) return Math.round(v / 1048576); } catch {}
  }
  return null;
}
export const nodeState = {
  enabled: false, reason: null, identity: null, uplink: "unknown", lastAttemptAt: null, lastOkAt: null, lastError: null,
  consecutiveFailures: 0, hosted: new Map(), running: false, lastRun: null
};
const ctx = () => ({ districtId: config.edenDistrictId, schoolId: config.edenSchoolId });
const agent = fn => withSystem("eden_agent", config.edenDistrictId, config.edenSchoolId, fn);

async function setState(fields) {
  const keys = Object.keys(fields);
  await agent(c => c.query(`INSERT INTO eden_node_state(district_id, school_id, ${keys.join(",")}) VALUES($1,$2,${keys.map((_, i) => `$${i + 3}`).join(",")})
    ON CONFLICT (district_id) DO UPDATE SET school_id=EXCLUDED.school_id, ${keys.map(k => `${k}=EXCLUDED.${k}`).join(",")}, updated_at=now()`,
    [config.edenDistrictId, config.edenSchoolId, ...keys.map(k => fields[k] !== null && typeof fields[k] === "object" && !(fields[k] instanceof Date) ? JSON.stringify(fields[k]) : fields[k])]));
}

// ---- identity / enrollment --------------------------------------------------
async function ensureIdentity() {
  if (nodeState.identity) return nodeState.identity;
  const root = pinnedRoot();
  let identity = await loadNodeIdentity();
  if (identity) {
    const v = verifyCertificate(identity.cert, { root, chain: identity.chain || [] });
    if (!v.ok) throw Object.assign(new Error(`node certificate invalid: ${v.reason}`), { code: "identity_invalid" });
    if (identity.schoolId !== config.edenSchoolId) throw Object.assign(new Error("identity file is for another school"), { code: "identity_mismatch" });
    nodeState.identity = identity;
    return identity;
  }
  if (!config.edenEnrollmentToken) throw Object.assign(new Error("not enrolled (set EDEN_ENROLLMENT_TOKEN once)"), { code: "not_enrolled" });
  const keys = generateIdentityKeys();
  const proof = proofOfPossession(keys.signPrivate, `${sha256(config.edenEnrollmentToken)}\n${keys.boxPublic}`);
  const r = await hubPost("/api/eden/v1/enroll", { token: config.edenEnrollmentToken, name: config.edenNodeName || `school node ${config.edenSchoolId.slice(0, 8)}`,
    signPublic: keys.signPublic, boxPublic: keys.boxPublic, proof });
  if (r.status !== 201) throw Object.assign(new Error(`enrollment refused: ${r.body?.error || r.status}`), { code: "enrollment_refused" });
  const { nodeId, cert, chain, root: theirRoot } = r.body;
  // Trust only what chains to OUR pinned root, for OUR keys and school.
  if (certificateFingerprint(theirRoot) !== certificateFingerprint(root)) throw Object.assign(new Error("hub presented a different root"), { code: "root_mismatch" });
  const v = verifyCertificate(cert, { root, chain });
  if (!v.ok || cert.keys.sign !== keys.signPublic || cert.subject.schoolId !== config.edenSchoolId || cert.subject.districtId !== config.edenDistrictId)
    throw Object.assign(new Error(`issued certificate rejected: ${v.reason || "subject mismatch"}`), { code: "cert_rejected" });
  identity = { nodeId, schoolId: config.edenSchoolId, districtId: config.edenDistrictId, keys, cert, chain, enrolledAt: new Date().toISOString() };
  await saveNodeIdentity(identity);
  await setState({ node_id: nodeId, enrolled_at: new Date() });
  nodeState.identity = identity;
  return identity;
}

// ---- aggregates -------------------------------------------------------------
export async function buildAggregates() {
  return agent(async c => {
    const day = (await c.query(`SELECT eduos_school_today($1)::text AS d`, [config.edenSchoolId])).rows[0].d;
    const identifiers = await loadIdentifiers(c, config.edenSchoolId);
    const out = { queued: 0, unchanged: 0, blocked: 0 };
    for (const kind of AGGREGATE_KINDS) {
      const period = DAILY.has(kind) ? day : "current";
      try {
        const src = (await c.query(`SELECT eduos_eden_source($1,$2,$3::date) AS x`, [kind, config.edenSchoolId, day])).rows[0].x;
        if (kind === "safety_summary" && !src.cells.length) continue;
        const payload = release({ kind, schoolId: config.edenSchoolId, period, cells: src.cells, meta: src.meta || undefined }, { identifiers });
        const q = await queueRelease(c, payload, { identifiers, schoolId: config.edenSchoolId });
        q.unchanged ? out.unchanged++ : out.queued++;
      } catch (e) {
        if (!(e instanceof GateError)) throw e;
        await logBlocked(c, { kind, period, reason: e.code });
        out.blocked++;
      }
    }
    const mem = process.memoryUsage();
    const ob = (await c.query(`SELECT count(*)::int n, extract(epoch FROM now()-min(created_at))::int age FROM eden_outbox WHERE sent_at IS NULL AND superseded_at IS NULL`)).rows[0];
    const replays = (await c.query(`SELECT count(*)::int n FROM offline_replays WHERE created_at > now()-interval '24 hours'`)).rows[0].n;
    const bundles = (await c.query(`SELECT count(*)::int n FROM eden_bundle_cache`)).rows[0].n;
    const health = release({ kind: "node_health", schoolId: config.edenSchoolId, period: "current", metrics: {
      version: APP_VERSION, arch: process.arch, tier: "school", uptimeSeconds: Math.round(process.uptime()), rssMb: mem.rss / 1048576, heapMb: mem.heapUsed / 1048576,
      loadAvg1: os.loadavg()[0], outboxPending: ob.n, outboxOldestSeconds: ob.age || 0,
      lastUplinkSeconds: nodeState.lastOkAt ? Math.round((Date.now() - nodeState.lastOkAt) / 1000) : 0, bundles, offlineReplays24h: replays, dbOk: 1 } });
    // Health changes every cycle; queue it only when the previous one has gone.
    const pendingHealth = (await c.query(`SELECT 1 FROM eden_outbox WHERE kind='node_health' AND sent_at IS NULL AND superseded_at IS NULL`)).rowCount;
    if (!pendingHealth) await queueRelease(c, health, { identifiers, schoolId: config.edenSchoolId });
    return out;
  });
}

// ---- one sync cycle -----------------------------------------------------------
export async function syncOnce() {
  if (nodeState.running) return { skipped: "already_running" };
  nodeState.running = true;
  const report = { at: new Date().toISOString() };
  try {
    report.aggregates = await buildAggregates();
    let identity;
    try { identity = await ensureIdentity(); }
    catch (e) { report.identity = e.code || e.message; return await uplinkFailed(report, e); }
    nodeState.lastAttemptAt = Date.now();
    const bundleVersions = await agent(async c => Object.fromEntries((await c.query(`SELECT kind,version FROM eden_bundle_cache`)).rows.map(r => [r.kind, r.version])));
    const st = await agent(async c => (await c.query(`SELECT * FROM eden_node_state WHERE district_id=$1`, [config.edenDistrictId])).rows[0]);
    const hosting = await agent(async c => (await c.query(`SELECT failover_id FROM decn_hosting WHERE status<>'purged'`)).rows.map(r => r.failover_id));
    const pending = await agent(async c => (await c.query(`SELECT count(*)::int n FROM eden_outbox WHERE sent_at IS NULL AND superseded_at IS NULL`)).rows[0].n);
    let hb;
    try {
      hb = await sendControl(identity, "heartbeat", "/api/eden/v1/heartbeat", { version: APP_VERSION, arch: process.arch, bundles: bundleVersions,
        continuitySha256: st?.continuity_sha256 || null, hosting, outboxPending: pending });
    } catch (e) { return await uplinkFailed(report, e); }
    if (hb.status !== 200 || !hb.body) return await uplinkFailed(report, Object.assign(new Error(`hub_http_${hb.status}${hb.body?.error ? `:${hb.body.error}` : ""}`), { code: "hub_refused" }));
    const d = hb.body;
    const chain = [d.districtCert];
    const root = pinnedRoot();
    const revoked = new Set(d.revokedSerials || []);
    report.flush = await flushOutbox(identity, ctx());
    report.bundles = await syncBundles(identity, d.bundles || [], root, chain);
    report.continuity = await syncContinuity(identity, d.partner, root, chain, revoked, st);
    report.host = await hostDirectives(identity, d, root, chain, revoked);
    report.returns = await importReturns(identity, d.returns || [], root, chain, revoked);
    nodeState.uplink = "online"; nodeState.lastOkAt = Date.now(); nodeState.lastError = null; nodeState.consecutiveFailures = 0;
    await setState({ last_attempt_at: new Date(), last_ok_at: new Date(), last_error: null, consecutive_failures: 0, partner: d.partner ? { nodeId: d.partner.nodeId, name: d.partner.cert?.subject?.name || null } : null,
      directives: { host: (d.host || []).length, handback: (d.handback || []).length, returns: (d.returns || []).length, bundles: (d.bundles || []).length } });
    return report;
  } finally { nodeState.running = false; nodeState.lastRun = report; await refreshHosted().catch(() => {}); }
}
async function uplinkFailed(report, e) {
  nodeState.uplink = "offline"; nodeState.lastError = String(e.code || e.cause?.code || e.message).slice(0, 200); nodeState.consecutiveFailures++;
  nodeState.lastAttemptAt = Date.now();
  await setState({ last_attempt_at: new Date(), last_error: nodeState.lastError, consecutive_failures: nodeState.consecutiveFailures }).catch(() => {});
  report.uplink = "offline"; report.error = nodeState.lastError;
  // Hosting a partner school is time-bounded even when we cannot reach the hub.
  return report;
}

async function syncBundles(identity, wanted, root, chain) {
  const out = [];
  for (const w of wanted) {
    const r = await download(identity, `/api/eden/v1/bundles/${encodeURIComponent(w.kind)}`).catch(() => null);
    if (!r || r.status !== 200) { out.push({ kind: w.kind, error: r ? r.status : "unreachable" }); continue; }
    const cur = await agent(async c => (await c.query(`SELECT version FROM eden_bundle_cache WHERE kind=$1`, [w.kind])).rows[0]);
    const v = verifyBundle(r.body.bundle, { root, chain, minVersion: cur?.version || 0 });
    if (!v.ok) { out.push({ kind: w.kind, rejected: v.reason }); continue; }
    const b = r.body.bundle;
    await agent(c => c.query(`INSERT INTO eden_bundle_cache(district_id,kind,version,signer,sha256,bundle) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT (district_id,kind) DO UPDATE SET version=EXCLUDED.version, signer=EXCLUDED.signer, sha256=EXCLUDED.sha256, bundle=EXCLUDED.bundle, verified_at=now()`,
      [config.edenDistrictId, b.kind, b.version, `${v.signer.kind}:${v.signer.id}`, sha256(canonical(b)), JSON.stringify(b)]));
    out.push({ kind: b.kind, version: b.version });
  }
  return out;
}

function partnerKeyOk(cert, root, chain, revoked) {
  const v = verifyCertificate(cert, { root, chain, revokedSerials: revoked });
  return v.ok && cert.subject.kind === "node" && cert.subject.districtId === config.edenDistrictId && cert.keys.box;
}
async function syncContinuity(identity, partner, root, chain, revoked, st) {
  if (!partner) return { skipped: "no_partner" };
  if (!partnerKeyOk(partner.cert, root, chain, revoked)) return { error: "partner_certificate_invalid" };
  const pkg = await agent(async c => (await c.query(`SELECT eduos_decn_continuity($1) AS p`, [config.edenSchoolId])).rows[0].p);
  const plain = canonical(pkg), hash = sha256(plain);
  const fresh = st?.continuity_sha256 === sha256(`${hash}:${partner.nodeId}`) && st?.continuity_sent_at && Date.now() - new Date(st.continuity_sent_at).getTime() < CONTINUITY_REFRESH_MS;
  if (fresh) return { unchanged: true };
  const envelope = seal({ plaintext: plain, recipientBoxPublic: partner.cert.keys.box, senderId: identity.nodeId, senderSignPrivate: identity.keys.signPrivate,
    recipientId: partner.nodeId, purpose: "decn_continuity", ref: config.edenSchoolId });
  const counts = { students: pkg.students.length, staff: pkg.staff.length, rosters: pkg.rosters.length, routes: pkg.routes.length, riders: pkg.riders.length,
    pickup_adults: pkg.pickupAdults.length, pickup_tags: pkg.pickupTags.length, restrictions: pkg.restrictions.length };
  const r = await sendSealed(identity, { ...ctx(), kind: "decn_continuity", apiPath: "/api/eden/v1/continuity", envelope, counts, partnerNodeId: partner.nodeId });
  if (r.status !== 200) return { error: r.error || `hub_http_${r.status}` };
  await setState({ continuity_sha256: sha256(`${hash}:${partner.nodeId}`), continuity_sent_at: new Date() });
  return { sent: true, counts };
}

// ---- DECN: hosting a partner school -------------------------------------------
async function hostDirectives(identity, d, root, chain, revoked) {
  const out = { activated: [], handedBack: [] };
  const local = await agent(async c => (await c.query(`SELECT * FROM decn_hosting WHERE status<>'purged'`)).rows);
  for (const h of d.host || []) {
    if (h.status !== "authorized" || local.some(l => l.failover_id === h.failoverId)) continue;
    const oc = h.originCert;
    if (!partnerKeyOk(oc, root, chain, revoked) || oc.subject.id !== h.originNodeId || oc.subject.schoolId !== h.schoolId) { out.activated.push({ id: h.failoverId, error: "origin_certificate_invalid" }); continue; }
    const r = await download(identity, `/api/eden/v1/failovers/${h.failoverId}/package`).catch(() => null);
    if (!r || r.status !== 200) { out.activated.push({ id: h.failoverId, error: "package_unavailable" }); continue; }
    const env = r.body.envelope;
    if (sha256(canonical(env)) !== h.packageSha256 || env.to !== identity.nodeId) { out.activated.push({ id: h.failoverId, error: "package_mismatch" }); continue; }
    let pkg;
    try { pkg = JSON.parse(open(env, { recipientBoxPrivate: identity.keys.boxPrivate, senderSignPublic: oc.keys.sign, expectPurpose: "decn_continuity" })); }
    catch (e) { out.activated.push({ id: h.failoverId, error: "package_unreadable" }); continue; }
    if (pkg.schoolId !== h.schoolId) { out.activated.push({ id: h.failoverId, error: "package_school_mismatch" }); continue; }
    const counts = await agent(async c => {
      const x = (await c.query(`SELECT eduos_decn_restore($1,$2,$3,$4,$5) AS c`, [h.failoverId, h.originNodeId, h.expiresAt, h.packageSha256, JSON.stringify(pkg)])).rows[0].c;
      await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail)
        VALUES($1,'eeeeeeee-0000-4000-8000-000000000001','eden_agent','decn_activate','eden_failover',$2,'success',$3)`, [config.edenDistrictId, h.failoverId, `school=${h.schoolId};${canonical(x)}`.slice(0, 500)]);
      return x;
    });
    await sendControl(identity, "activated", `/api/eden/v1/failovers/${h.failoverId}/activated`, { counts: numeric(counts) }).catch(() => null);
    out.activated.push({ id: h.failoverId, counts });
  }
  // Hand back: on the district's word, or on our own clock when the window ends.
  const handback = new Map((d.handback || []).map(x => [x.failoverId, x]));
  const stillHosted = new Set((d.host || []).map(x => x.failoverId));
  for (const l of await agent(async c => (await c.query(`SELECT * FROM decn_hosting WHERE status<>'purged'`)).rows)) {
    const hb = handback.get(l.failover_id);
    const expired = new Date(l.expires_at) < new Date();
    if (!hb && !expired && stillHosted.has(l.failover_id)) continue;
    const originCert = hb?.originCert || (d.host || []).find(x => x.failoverId === l.failover_id)?.originCert;
    if (!originCert || !partnerKeyOk(originCert, root, chain, revoked)) { out.handedBack.push({ id: l.failover_id, waiting: "origin_certificate" }); continue; }
    const ret = await agent(async c => (await c.query(`SELECT eduos_decn_return_package($1) AS p`, [l.failover_id])).rows[0].p);
    const envelope = seal({ plaintext: canonical(ret), recipientBoxPublic: originCert.keys.box, senderId: identity.nodeId, senderSignPrivate: identity.keys.signPrivate,
      recipientId: originCert.subject.id, purpose: "decn_return", ref: l.failover_id });
    const counts = { attendance: ret.attendance.length, incidents: ret.incidents.length, safety_events: ret.safetyEvents.length, rollcall: ret.rollcall.length,
      transport_runs: ret.runs.length, transport_checkins: ret.checkins.length, pickup_events: ret.pickupEvents.length, audit: ret.audit.length };
    const r = await sendSealed(identity, { ...ctx(), kind: "decn_return", apiPath: `/api/eden/v1/failovers/${l.failover_id}/return`, envelope, counts });
    if (r.status !== 200) { out.handedBack.push({ id: l.failover_id, waiting: r.error || `hub_http_${r.status}` }); continue; }
    // Only after the return package is safely with the district: erase.
    const purge = await agent(async c => {
      await c.query(`UPDATE decn_hosting SET status='returning', return_sha256=$2, returned_at=now() WHERE failover_id=$1`, [l.failover_id, sha256(canonical(envelope))]);
      const x = (await c.query(`SELECT eduos_decn_purge($1) AS c`, [l.failover_id])).rows[0].c;
      await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail)
        VALUES($1,'eeeeeeee-0000-4000-8000-000000000001','eden_agent','decn_purge','eden_failover',$2,'success',$3)`, [config.edenDistrictId, l.failover_id, canonical(x).slice(0, 500)]);
      return x;
    });
    await sendControl(identity, "purged", `/api/eden/v1/failovers/${l.failover_id}/purged`, { counts: numeric(purge) }).catch(() => null);
    out.handedBack.push({ id: l.failover_id, returned: counts, purged: purge });
  }
  return out;
}
const numeric = o => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => /^[a-z_]{1,40}$/.test(k) && Number.isInteger(Number(v))).map(([k, v]) => [k, Number(v)]));

// ---- DECN: taking our school back -----------------------------------------------
async function importReturns(identity, returns, root, chain, revoked) {
  const out = [];
  for (const r0 of returns) {
    if (!partnerKeyOk(r0.partnerCert, root, chain, revoked)) { out.push({ id: r0.failoverId, error: "partner_certificate_invalid" }); continue; }
    const r = await download(identity, `/api/eden/v1/failovers/${r0.failoverId}/return`).catch(() => null);
    if (!r || r.status !== 200) { out.push({ id: r0.failoverId, error: "return_unavailable" }); continue; }
    let pkg;
    try { pkg = JSON.parse(open(r.body.envelope, { recipientBoxPrivate: identity.keys.boxPrivate, senderSignPublic: r0.partnerCert.keys.sign, expectPurpose: "decn_return" })); }
    catch { out.push({ id: r0.failoverId, error: "return_unreadable" }); continue; }
    const counts = await agent(async c => {
      const x = (await c.query(`SELECT eduos_decn_import_return($1,$2,$3) AS c`, [r0.failoverId, sha256(canonical(r.body.envelope)), JSON.stringify(pkg)])).rows[0].c;
      await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail)
        VALUES($1,'eeeeeeee-0000-4000-8000-000000000001','eden_agent','decn_import','eden_failover',$2,'success',$3)`, [config.edenDistrictId, r0.failoverId, canonical(x).slice(0, 500)]);
      return x;
    });
    await sendControl(identity, "imported", `/api/eden/v1/failovers/${r0.failoverId}/imported`, { counts: numeric(counts) }).catch(() => null);
    out.push({ id: r0.failoverId, counts });
  }
  return out;
}

async function refreshHosted() {
  const rows = await agent(async c => (await c.query(`SELECT failover_id, hosted_school_id, expires_at, status FROM decn_hosting WHERE status='active'`)).rows);
  nodeState.hosted = new Map(rows.map(r => [r.hosted_school_id, { failoverId: r.failover_id, expiresAt: new Date(r.expires_at) }]));
}

let timer = null;
export function startAgent() {
  if (timer || !nodeState.enabled) return;
  const loop = async () => {
    try { await syncOnce(); } catch (e) { console.error("EDEN sync failed:", e.message); }
    // Back off while the uplink is down (max 5 minutes), resume quickly when up.
    const backoff = nodeState.uplink === "offline" ? Math.min(300_000, config.edenSyncIntervalMs * 2 ** Math.min(nodeState.consecutiveFailures - 1, 4)) : config.edenSyncIntervalMs;
    timer = setTimeout(loop, backoff); timer.unref?.();
  };
  timer = setTimeout(loop, 1500); timer.unref?.();
}
export function stopAgent() { if (timer) clearTimeout(timer); timer = null; }

// =============================================================================
// Routes: node status for the principal / district IT, egress log, consent.
// =============================================================================
export function registerEdenNode(app) {
  const problems = [];
  if (!UUID.test(config.edenDistrictId)) problems.push("EDEN_DISTRICT_ID");
  if (!UUID.test(config.edenSchoolId)) problems.push("EDEN_SCHOOL_ID");
  if (!pinnedRoot()) problems.push("EDEN_ROOT_CERT");
  nodeState.enabled = problems.length === 0;
  nodeState.reason = problems.length ? `missing or invalid: ${problems.join(", ")}` : null;
  if (!nodeState.enabled) console.warn(`EDEN school node agent disabled (${nodeState.reason}); the school apps still run locally.`);
  else refreshHosted().catch(() => {});

  addSessionGuard(req => {
    const h = nodeState.hosted.get(req.actor?.schoolId);
    if (!h) return null;
    if (h.expiresAt < new Date()) return "failover_window_ended";
    return HOSTED_ALLOW.some(rx => rx.test(req.path)) ? null : "not_available_during_failover";
  });

  const nodeRead = [requireSession, requirePermission("eden", "node")];
  const syncLimiter = rateLimit({ windowMs: 60_000, limit: config.edenSyncNowPerMinute, standardHeaders: true, legacyHeaders: false });
  app.get("/api/node/status", ...nodeRead, async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async c => {
        const st = (await c.query(`SELECT * FROM eden_node_state WHERE district_id=$1`, [req.actor.districtId])).rows[0] || null;
        const school = (await c.query(`SELECT id,name FROM schools WHERE id=$1`, [config.edenSchoolId])).rows[0] || null;
        const ob = (await c.query(`SELECT count(*) FILTER (WHERE sent_at IS NULL AND superseded_at IS NULL)::int pending,
            min(created_at) FILTER (WHERE sent_at IS NULL AND superseded_at IS NULL) oldest, count(*) FILTER (WHERE sent_at IS NOT NULL)::int sent,
            max(sent_at) last_sent FROM eden_outbox`)).rows[0];
        const eg = (await c.query(`SELECT decision, count(*)::int n FROM eden_egress_log WHERE at > now()-interval '24 hours' GROUP BY 1`)).rows;
        const bundles = (await c.query(`SELECT kind,version,signer,verified_at FROM eden_bundle_cache ORDER BY kind`)).rows;
        const hosting = (await c.query(`SELECT h.failover_id,h.hosted_school_id,s.name AS school_name,h.status,h.activated_at,h.expires_at,h.restored_counts,h.purged_at,h.purge_counts
            FROM decn_hosting h JOIN schools s ON s.id=h.hosted_school_id ORDER BY h.activated_at DESC LIMIT 10`)).rows;
        const imports = (await c.query(`SELECT failover_id,counts,imported_at FROM decn_imports ORDER BY imported_at DESC LIMIT 10`)).rows;
        return { st, school, ob, eg, bundles, hosting, imports };
      });
      const mem = process.memoryUsage();
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: {
        tier: "school", version: APP_VERSION, arch: process.arch, platform: process.platform, enabled: nodeState.enabled, reason: nodeState.reason,
        node: { id: nodeState.identity?.nodeId || data.st?.node_id || null, enrolledAt: data.st?.enrolled_at || null, certExpires: nodeState.identity?.cert?.notAfter || null },
        school: data.school,
        uplink: { state: nodeState.uplink, lastOkAt: data.st?.last_ok_at || null, lastAttemptAt: data.st?.last_attempt_at || null, lastError: data.st?.last_error || null,
          consecutiveFailures: data.st?.consecutive_failures || 0, hub: config.edenHubUrl ? new URL(config.edenHubUrl).host : null },
        outbox: data.ob, egress24h: Object.fromEntries(data.eg.map(r => [r.decision, r.n])), bundles: data.bundles,
        partner: data.st?.partner || null, continuitySentAt: data.st?.continuity_sent_at || null,
        hosting: data.hosting, imports: data.imports, consentExceptions: config.edenConsentExceptions ? "on" : "off",
        resources: { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), loadAvg1: Math.round(os.loadavg()[0] * 100) / 100, totalMemMb: Math.round(os.totalmem() / 1048576), limitMb: cgroupLimitMb() }
      } });
    } catch (e) { next(e); }
  });
  app.get("/api/node/egress", ...nodeRead, async (req, res, next) => {
    try {
      const rows = await withTenantTransaction(req.actor, async c => (await c.query(`SELECT id,at,destination,kind,period,decision,reason,cells,cells_suppressed,bytes,sha256
        FROM eden_egress_log ORDER BY at DESC LIMIT 100`)).rows);
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: rows });
    } catch (e) { next(e); }
  });
  // The exact payload that left (or will leave) the node, for inspection.
  app.get("/api/node/outbox/:id", ...nodeRead, async (req, res, next) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    try {
      const row = await withTenantTransaction(req.actor, async c => (await c.query(`SELECT id,kind,period,payload,sha256,created_at,sent_at,superseded_at,last_error FROM eden_outbox WHERE id=$1`, [req.params.id])).rows[0]);
      if (!row) return res.status(404).json({ error: "not_found" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: row });
    } catch (e) { next(e); }
  });
  app.post("/api/node/sync-now", syncLimiter, requireSession, requireCsrf, requirePermission("eden", "node"), async (req, res, next) => {
    if (!nodeState.enabled) return res.status(503).json({ error: "eden_not_configured", reason: nodeState.reason });
    try {
      const report = await syncOnce();
      await withTenantTransaction(req.actor, c => c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail)
        VALUES($1,$2,$3,'eden_sync_now','eden_node',$4,'success',$5)`, [req.actor.districtId, req.actor.userId, req.actor.role, nodeState.identity?.nodeId || null, report.uplink || "online"]));
      res.json({ data: { uplink: nodeState.uplink, error: nodeState.lastError, flush: report.flush || null, aggregates: report.aggregates || null } });
    } catch (e) { next(e); }
  });
  app.get("/api/node/hosting", requireSession, async (req, res) => {
    const h = nodeState.hosted.get(req.actor.schoolId);
    res.setHeader("Cache-Control", "no-store");
    res.json({ data: h ? { hosted: true, failoverId: h.failoverId, expiresAt: h.expiresAt } : { hosted: false } });
  });
  app.get("/api/node/bundles/:kind", requireSession, async (req, res, next) => {
    if (!/^[a-z]{3,20}$/.test(req.params.kind)) return res.status(400).json({ error: "invalid_kind" });
    try {
      const row = await withSystem("eden_agent", req.actor.districtId, req.actor.schoolId, async c => (await c.query(`SELECT kind,version,signer,verified_at,bundle->'payload' AS payload FROM eden_bundle_cache WHERE kind=$1`, [req.params.kind])).rows[0]);
      if (!row) return res.status(404).json({ error: "not_cached" });
      res.json({ data: row });
    } catch (e) { next(e); }
  });

  // ---- consent-gated exception (OFF by default) --------------------------------
  app.post("/api/node/consent-exceptions", requireSession, requireCsrf, requirePermission("eden", "node"), async (req, res, next) => {
    const { studentId, consentReference } = req.body || {};
    if (!["principal", "superintendent"].includes(req.actor.role)) return res.status(403).json({ error: "role_not_allowed" });
    if (!UUID.test(String(studentId)) || typeof consentReference !== "string" || consentReference.trim().length < 3 || consentReference.length > 120) return res.status(400).json({ error: "invalid_request" });
    try {
      const row = await withTenantTransaction(req.actor, async c => {
        const s = (await c.query(`SELECT id,school_id FROM students WHERE id=$1 AND ($2::uuid IS NULL OR school_id=$2)`, [studentId, req.actor.role === "principal" ? req.actor.schoolId : null])).rows[0];
        if (!s) return null;
        const x = (await c.query(`INSERT INTO eden_consent_exceptions(district_id,school_id,student_id,purpose,consent_reference,requested_by,expires_at)
          VALUES($1,$2,$3,'records_transfer',$4,$5,now()+interval '14 days') RETURNING id,status,expires_at`, [req.actor.districtId, s.school_id, s.id, consentReference.trim(), req.actor.userId])).rows[0];
        await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail) VALUES($1,$2,$3,'consent_exception_request','eden_consent_exception',$4,'success',$5)`,
          [req.actor.districtId, req.actor.userId, req.actor.role, x.id, `student=${s.id};enabled=${config.edenConsentExceptions}`]);
        return x;
      });
      if (!row) return res.status(404).json({ error: "student_not_found" });
      res.status(201).json({ data: { ...row, enabled: config.edenConsentExceptions } });
    } catch (e) { next(e); }
  });
  app.post("/api/node/consent-exceptions/:id/approve", requireSession, requireCsrf, requirePermission("eden", "node"), async (req, res, next) => {
    if (req.actor.role !== "superintendent") return res.status(403).json({ error: "superintendent_only" });
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    try {
      const ok = await withTenantTransaction(req.actor, async c => {
        const r = await c.query(`UPDATE eden_consent_exceptions SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1 AND status='requested' AND requested_by<>$2 AND expires_at>now()`, [req.params.id, req.actor.userId]);
        if (r.rowCount) await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome) VALUES($1,$2,$3,'consent_exception_approve','eden_consent_exception',$4,'success')`,
          [req.actor.districtId, req.actor.userId, req.actor.role, req.params.id]);
        return r.rowCount > 0;
      });
      ok ? res.json({ data: { ok: true } }) : res.status(409).json({ error: "not_approvable" });
    } catch (e) { next(e); }
  });
  app.post("/api/node/consent-exceptions/:id/send", requireSession, requireCsrf, requirePermission("eden", "node"), async (req, res, next) => {
    if (!["principal", "superintendent"].includes(req.actor.role)) return res.status(403).json({ error: "role_not_allowed" });
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    try {
      if (!config.edenConsentExceptions) {
        await withTenantTransaction(req.actor, async c => {
          await c.query(`INSERT INTO eden_egress_log(district_id,destination,kind,decision,reason,actor_user_id) VALUES($1,'district','consented_record_transfer','blocked','consent_exceptions_disabled',$2)`, [req.actor.districtId, req.actor.userId]);
          await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail) VALUES($1,$2,$3,'consent_exception_send','eden_consent_exception',$4,'denied','disabled')`,
            [req.actor.districtId, req.actor.userId, req.actor.role, req.params.id]);
        });
        return res.status(403).json({ error: "consent_exceptions_disabled" });
      }
      const out = await withSystem("eden_agent", req.actor.districtId, config.edenSchoolId, async c => {
        const x = (await c.query(`SELECT * FROM eden_consent_exceptions WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
        if (!x) return { status: 404, error: "not_found" };
        const exception = { id: x.id, status: x.status, purpose: x.purpose, studentId: x.student_id, schoolId: x.school_id, consentReference: x.consent_reference, expiresAt: x.expires_at, usedAt: x.used_at };
        // Identity fields only (grades would be added here for a real transfer).
        const rec = (await c.query(`SELECT eduos_decn_continuity($1) AS p`, [x.school_id])).rows[0].p.students.find(s => s.id === x.student_id);
        if (!rec) return { status: 404, error: "student_not_found" };
        let payload;
        try { payload = releaseConsented({ exception, record: { studentId: rec.id, displayName: rec.name, gradeLevel: rec.grade, finalGrades: [] } }, { enabled: true }); }
        catch (e) { await logBlocked(c, { kind: "consented_record_transfer", reason: e.code, actorUserId: req.actor.userId }); return { status: 409, error: e.code }; }
        await c.query(`UPDATE eden_consent_exceptions SET status='used', used_at=now() WHERE id=$1`, [x.id]);
        const q = await queueRelease(c, payload, { identifiers: null, schoolId: x.school_id, actorUserId: req.actor.userId, consent: true });
        await c.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail) VALUES($1,$2,$3,'consent_exception_send','eden_consent_exception',$4,'success',$5)`,
          [req.actor.districtId, req.actor.userId, req.actor.role, x.id, `outbox=${q.id}`]);
        return { status: 201, body: { outboxId: q.id } };
      });
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.status(201).json({ data: out.body });
    } catch (e) { next(e); }
  });
  return nodeState;
}
