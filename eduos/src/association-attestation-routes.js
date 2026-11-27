// SPORT-05: signed athlete eligibility attestations for a state athletic
// association (db/159).
//
//   Superintendent
//     GET  /api/district/athletic-associations            agreements, with recent reads by the association
//     POST /api/district/athletic-associations            new agreement; returns the association's access token once
//     POST /api/district/athletic-associations/:id/revoke {reason}
//     POST /api/district/athletic-associations/:id/token  replace the access token (the old one stops working)
//   Parent or guardian
//     GET  /api/family/association-consents
//     PUT  /api/family/association-consents/:studentId    {agreementId, share: true|false}
//   The school's athletic director (sport teams)
//     GET  /api/activities/:id/attestations
//     POST /api/activities/:id/attestations              {agreementId, validDays}: certify the team; returns the signed file
//     POST /api/attestations/:id/withdraw                 {reason}
//   The association (no EduOS account): Authorization: Bearer <agreement id>.<token>
//     GET  /api/association/attestations                  current attestations, and the key that signs them
//     GET  /api/association/attestations/:id              one signed attestation
//
// Only athletes whose parent or guardian agreed are listed, with only a
// reference, name, grade and status. Reasons, grades and attendance never
// leave. The association reads only while the agreement is in force, and
// every read is logged (association_reads).
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction, pool } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { evaluateTeam } from "./sports-eligibility.js";
import { exchangeKeys } from "./federation/exchange.js";
import { buildAttestation, signAttestation, DEFAULT_VALID_DAYS, MAX_VALID_DAYS } from "./federation/eligibility.js";

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);
const ymd = v => v instanceof Date ? v.toISOString().slice(0, 10) : v;
const keys = () => exchangeKeys(process.env.EXCHANGE_SIGNING_SECRET || "");
const REF = /^[a-z0-9][a-z0-9-]{1,79}$/, DAY = /^\d{4}-\d{2}-\d{2}$/;
const inForce = a => a.status === "active" && ymd(a.effective_from) <= today() && ymd(a.effective_to) >= today();
const agreementOut = a => ({ id: a.id, associationRef: a.association_ref, associationName: a.association_name, purpose: a.purpose, legalBasis: a.legal_basis,
  effectiveFrom: ymd(a.effective_from), effectiveTo: ymd(a.effective_to), status: a.status, inForce: inForce(a), approvedAt: a.approved_at,
  revokedAt: a.revoked_at, revokeReason: a.revoke_reason });
const run = fn => async (req, res, next) => {
  // fn returns the data, or {status, data} to set the status code.
  try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); const wrapped = Number.isInteger(out?.status) && "data" in out;
    res.setHeader("Cache-Control", "no-store"); res.status(wrapped ? out.status : 200).json({ data: wrapped ? out.data : out }); }
  catch (e) { sendError(res, next, e); }
};
const only = roles => (req, res, next) => roles.includes(req.actor?.role) ? next() : res.status(403).json({ error: "not_allowed" });
const newToken = () => crypto.randomBytes(32).toString("base64url");

async function sportTeamForAd(c, req) {
  if (!validId(req.params.id)) throw new HttpError(400, "invalid_activity_id");
  const a = await one(c, "SELECT id, school_id, title, kind FROM school_activities WHERE id=$1 AND district_id=$2", [req.params.id, req.actor.districtId]);
  if (!a || a.kind !== "sport") throw new HttpError(404, "activity_not_found");
  if (!(await one(c, "SELECT eduos_is_athletic_director($1) AS ok", [a.school_id])).ok) throw new HttpError(403, "athletic_director_only");
  return a;
}

export function registerAssociationAttestationRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `aa:${req.actor?.userId}` });
  const external = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

  // ---------- superintendent ----------
  app.get("/api/district/athletic-associations", requireSession, only(["superintendent"]), run(async c => {
    const list = await rows(c, "SELECT * FROM athletic_association_agreements ORDER BY approved_at DESC");
    const reads = await rows(c, "SELECT agreement_id, attestation_id, action, outcome, reason, read_at FROM association_reads ORDER BY read_at DESC LIMIT 100");
    const counts = await rows(c, `SELECT agreement_id, count(*) FILTER (WHERE revoked_at IS NULL)::int AS consents FROM athlete_association_consents GROUP BY 1`);
    const k = keys();
    return { signingConfigured: !!k, fingerprint: k?.fingerprint || null, agreements: list.map(a => ({ ...agreementOut(a),
      consents: counts.find(x => x.agreement_id === a.id)?.consents || 0,
      reads: reads.filter(r => r.agreement_id === a.id).slice(0, 20).map(r => ({ action: r.action, outcome: r.outcome, reason: r.reason, attestationId: r.attestation_id, at: r.read_at })) })) };
  }));

  app.post("/api/district/athletic-associations", limiter, requireSession, requireCsrf, only(["superintendent"]), run(async (c, req) => {
    const b = req.body || {};
    const from = b.effectiveFrom || today();
    if (!REF.test(b.associationRef || "") || !cleanText(b.associationName, 200, 2) || !cleanText(b.legalBasis, 500, 3) || !DAY.test(from) || !DAY.test(b.effectiveTo || "") || b.effectiveTo < from)
      throw new HttpError(400, "invalid_agreement", { hint: "associationRef (lowercase id), associationName, legalBasis, effectiveTo (YYYY-MM-DD, not before the start)" });
    const token = newToken();
    const a = await one(c, `INSERT INTO athletic_association_agreements(district_id, association_ref, association_name, legal_basis, effective_from, effective_to, token_hash, approved_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [req.actor.districtId, b.associationRef, b.associationName.trim(), b.legalBasis.trim(), from, b.effectiveTo, sha256(token), req.actor.userId]);
    await audit(c, req, "create", "athletic_association_agreement", a.id, `association=${a.association_ref};from=${from};to=${b.effectiveTo}`);
    return { status: 201, data: { ...agreementOut(a), accessToken: `${a.id}.${token}`, note: "Give this token to the association once, over a secure channel. It isn't shown again." } };
  }));

  app.post("/api/district/athletic-associations/:id/revoke", limiter, requireSession, requireCsrf, only(["superintendent"]), run(async (c, req) => {
    const reason = req.body?.reason;
    if (!validId(req.params.id) || !cleanText(reason, 500, 3)) throw new HttpError(400, "reason_required");
    const a = await one(c, `UPDATE athletic_association_agreements SET status='revoked', revoked_by=$2, revoked_at=now(), revoke_reason=$3 WHERE id=$1 AND status='active' RETURNING *`,
      [req.params.id, req.actor.userId, reason.trim()]);
    if (!a) throw new HttpError(404, "agreement_not_found");
    await audit(c, req, "revoke", "athletic_association_agreement", a.id, reason.trim());
    return { data: agreementOut(a) };
  }));

  app.post("/api/district/athletic-associations/:id/token", limiter, requireSession, requireCsrf, only(["superintendent"]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_agreement_id");
    const token = newToken();
    const a = await one(c, "UPDATE athletic_association_agreements SET token_hash=$2 WHERE id=$1 AND status='active' RETURNING id", [req.params.id, sha256(token)]);
    if (!a) throw new HttpError(404, "agreement_not_found");
    await audit(c, req, "rotate_token", "athletic_association_agreement", a.id);
    return { accessToken: `${a.id}.${token}` };
  }));

  // ---------- parents and guardians ----------
  app.get("/api/family/association-consents", requireSession, only(["parent"]), run(async (c, req) => {
    const kids = await rows(c, `SELECT DISTINCT s.id, s.display_name AS name FROM student_user_links l JOIN students s ON s.id=l.student_id
        WHERE l.user_id=$1 AND l.relationship IN ('parent','guardian') AND l.status='active' ORDER BY s.display_name`, [req.actor.userId]);
    const ags = (await rows(c, "SELECT * FROM athletic_association_agreements WHERE status='active' ORDER BY association_name")).filter(inForce);
    const open = kids.length ? await rows(c, "SELECT student_id, agreement_id, granted_at FROM athlete_association_consents WHERE student_id = ANY($1) AND revoked_at IS NULL", [kids.map(k => k.id)]) : [];
    const teams = kids.length ? await rows(c, `SELECT r.student_id, a.title FROM activity_roster_entries r JOIN school_activities a ON a.id=r.activity_id
        WHERE r.student_id = ANY($1) AND r.status='active' AND a.kind='sport'`, [kids.map(k => k.id)]) : [];
    return { agreements: ags.map(a => ({ id: a.id, associationName: a.association_name, purpose: a.purpose, legalBasis: a.legal_basis, effectiveTo: ymd(a.effective_to) })),
      students: kids.map(k => ({ studentId: k.id, name: k.name, teams: teams.filter(t => t.student_id === k.id).map(t => t.title),
        consents: Object.fromEntries(ags.map(a => [a.id, open.find(o => o.student_id === k.id && o.agreement_id === a.id)?.granted_at || null])) })),
      shares: "If you agree, the school's athletic director can confirm to the association your child's name, grade, school, team and whether they are eligible, not eligible or pending. Grades, attendance and reasons are never shared." };
  }));

  app.put("/api/family/association-consents/:studentId", limiter, requireSession, requireCsrf, only(["parent"]), run(async (c, req) => {
    const sid = req.params.studentId, b = req.body || {};
    if (!validId(sid) || !validId(b.agreementId) || typeof b.share !== "boolean") throw new HttpError(400, "invalid_choice");
    const kid = await one(c, "SELECT id, school_id FROM students WHERE id=$1 AND eduos_is_family_of(id)", [sid]);
    if (!kid) throw new HttpError(404, "student_not_found");
    const ag = await one(c, "SELECT * FROM athletic_association_agreements WHERE id=$1", [b.agreementId]);
    if (!ag || (b.share && !inForce(ag))) throw new HttpError(404, "agreement_not_found");
    const open = await one(c, "SELECT id FROM athlete_association_consents WHERE student_id=$1 AND agreement_id=$2 AND revoked_at IS NULL", [sid, ag.id]);
    let withdrawn = 0;
    if (b.share && !open) {
      await c.query("INSERT INTO athlete_association_consents(district_id, school_id, student_id, agreement_id, granted_by) VALUES ($1,$2,$3,$4,$5)", [req.actor.districtId, kid.school_id, sid, ag.id, req.actor.userId]);
      await audit(c, req, "grant", "athlete_association_consent", sid, `agreement=${ag.id}`);
    }
    if (!b.share && open) {
      await c.query("UPDATE athlete_association_consents SET revoked_at=now(), revoked_by=$2 WHERE id=$1", [open.id, req.actor.userId]);
      // Anything already certified that lists this athlete stops being readable.
      withdrawn = (await c.query(`UPDATE eligibility_attestations SET withdrawn_at=now(), withdrawn_by=$3, withdraw_reason='A parent or guardian withdrew consent'
        WHERE agreement_id=$1 AND $2 = ANY(student_ids) AND withdrawn_at IS NULL AND expires_on >= (now() AT TIME ZONE 'UTC')::date`, [ag.id, sid, req.actor.userId])).rowCount;
      await audit(c, req, "revoke", "athlete_association_consent", sid, `agreement=${ag.id};withdrawn=${withdrawn}`);
    }
    return { saved: true, attestationsWithdrawn: withdrawn };
  }));

  // ---------- athletic directors ----------
  app.get("/api/activities/:id/attestations", requireSession, run(async (c, req) => {
    const team = await sportTeamForAd(c, req);
    const ags = (await rows(c, "SELECT * FROM athletic_association_agreements WHERE status='active' ORDER BY association_name")).filter(inForce);
    const roster = await rows(c, "SELECT student_id FROM activity_roster_entries WHERE activity_id=$1 AND status='active'", [team.id]);
    const consents = await rows(c, "SELECT agreement_id, student_id FROM athlete_association_consents WHERE revoked_at IS NULL AND student_id = ANY($1)", [roster.map(r => r.student_id)]);
    const list = await rows(c, `SELECT e.id, e.agreement_id, e.as_of, e.expires_on, e.athletes, e.withheld, e.sha256, e.attested_at, e.withdrawn_at, e.withdraw_reason, u.display_name AS by
        FROM eligibility_attestations e JOIN users u ON u.id=e.attested_by WHERE e.activity_id=$1 ORDER BY e.attested_at DESC LIMIT 50`, [team.id]);
    return { team: team.title, signingConfigured: !!keys(),
      agreements: ags.map(a => ({ id: a.id, associationName: a.association_name, rosterSize: roster.length, consented: consents.filter(x => x.agreement_id === a.id).length })),
      attestations: list.map(e => ({ id: e.id, agreementId: e.agreement_id, asOf: ymd(e.as_of), expiresOn: ymd(e.expires_on), athletes: e.athletes, withheld: e.withheld, sha256: e.sha256,
        attestedAt: e.attested_at, by: e.by, withdrawnAt: e.withdrawn_at, withdrawReason: e.withdraw_reason })) };
  }));

  app.post("/api/activities/:id/attestations", limiter, requireSession, requireCsrf, async (req, res, next) => {
    try {
      const k = keys();
      if (!k) throw new HttpError(503, "exchange_signing_not_configured");
      const b = req.body || {}, validDays = b.validDays === undefined ? DEFAULT_VALID_DAYS : b.validDays;
      if (!validId(b.agreementId) || !Number.isInteger(validDays) || validDays < 1 || validDays > MAX_VALID_DAYS) throw new HttpError(400, "invalid_request", { hint: `agreementId and validDays (1-${MAX_VALID_DAYS})` });
      const signed = await withTenantTransaction(req.actor, async c => {
        const team = await sportTeamForAd(c, req);
        const ag = await one(c, "SELECT * FROM athletic_association_agreements WHERE id=$1", [b.agreementId]);
        if (!ag) throw new HttpError(404, "agreement_not_found");
        if (!inForce(ag)) throw new HttpError(409, "agreement_not_in_force");
        const inputs = (await one(c, "SELECT eduos_sports_eligibility_inputs($1) AS j", [team.id])).j;
        const evaluated = evaluateTeam(inputs);
        const consented = new Set((await rows(c, "SELECT student_id FROM athlete_association_consents WHERE agreement_id=$1 AND revoked_at IS NULL", [ag.id])).map(r => r.student_id));
        const [district, school, me] = await Promise.all([one(c, "SELECT id, name FROM districts WHERE id=$1", [req.actor.districtId]),
          one(c, "SELECT name FROM schools WHERE id=$1", [team.school_id]), one(c, "SELECT display_name FROM users WHERE id=$1", [req.actor.userId])]);
        const id = crypto.randomUUID();
        const body = buildAttestation({ id, agreement: ag, district, school, activity: team, team: evaluated, policy: inputs.policy, consented,
          secret: process.env.EXCHANGE_SIGNING_SECRET, asOf: today(), validDays, attestedBy: { name: me.display_name } });
        const env = signAttestation(body, k);
        const ids = evaluated.students.filter(s => consented.has(s.studentId)).map(s => s.studentId);
        await c.query(`INSERT INTO eligibility_attestations(id, district_id, school_id, activity_id, agreement_id, as_of, expires_on, athletes, withheld, student_ids, sha256, envelope, attested_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, req.actor.districtId, team.school_id, team.id, ag.id, body.as_of, body.expires_on, body.athletes.length, body.withheld, ids, env.signature.sha256, env, req.actor.userId]);
        await audit(c, req, "attest", "eligibility_attestation", id, `activity=${team.id};agreement=${ag.id};athletes=${body.athletes.length};withheld=${body.withheld};sha256=${env.signature.sha256}`);
        return env;
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", `attachment; filename="eligibility-${signed.attestation_id}.json"`);
      res.status(201).type("application/json").send(JSON.stringify(signed, null, 2));
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/attestations/:id/withdraw", limiter, requireSession, requireCsrf, run(async (c, req) => {
    const reason = req.body?.reason;
    if (!validId(req.params.id) || !cleanText(reason, 500, 3)) throw new HttpError(400, "reason_required");
    const e = await one(c, "SELECT id, activity_id, school_id FROM eligibility_attestations WHERE id=$1 AND withdrawn_at IS NULL", [req.params.id]);
    if (!e) throw new HttpError(404, "attestation_not_found");
    if (!(await one(c, "SELECT eduos_is_athletic_director($1) AS ok", [e.school_id])).ok) throw new HttpError(403, "athletic_director_only");
    await c.query("UPDATE eligibility_attestations SET withdrawn_at=now(), withdrawn_by=$2, withdraw_reason=$3 WHERE id=$1", [e.id, req.actor.userId, reason.trim()]);
    await audit(c, req, "withdraw", "eligibility_attestation", e.id, reason.trim());
    return { withdrawn: true };
  }));

  // ---------- the association ----------
  const bearer = req => /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,100})$/.exec(req.get("authorization") || "");
  const access = attestation => async (req, res, next) => {
    try {
      const m = bearer(req);
      if (!m || !validId(m[1])) return res.status(401).json({ error: "unauthorized" });
      if (attestation && !validId(req.params.id)) return res.status(400).json({ error: "invalid_attestation_id" });
      const r = (await pool.query("SELECT eduos_association_access($1, $2, $3) AS out", [m[1], sha256(m[2]), attestation ? req.params.id : null])).rows[0].out;
      res.setHeader("Cache-Control", "no-store");
      if (!r.ok) return res.status(r.error === "unauthorized" ? 401 : r.error === "agreement_not_in_force" ? 403 : r.error === "not_found" ? 404 : 410).json({ error: r.error });
      if (attestation) return res.type("application/json").send(JSON.stringify(r.envelope, null, 2));
      const k = keys();
      res.json({ data: { attestations: r.attestations, signingKey: k ? { publicKey: k.public, fingerprint: k.fingerprint, alg: "Ed25519" } : null } });
    } catch (e) { next(e); }
  };
  app.get("/api/association/attestations", external, access(false));
  app.get("/api/association/attestations/:id", external, access(true));
}
