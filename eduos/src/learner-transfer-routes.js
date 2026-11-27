// HSP-06: controlled learner transfers between homeschool families and private
// schools (db/165). The same routes exist under /api/homeschool and
// /api/private-school, each in its own session context:
//
//   GET  …/transfers                       what this family or school has sent and received
//   POST …/transfers {learnerId, purpose, sections, note?}
//        family: returns the one-time code (shown once). school: awaits a guardian's release.
//   POST /api/private-school/transfers/:id/release   a guardian with full authority; returns the code
//   POST …/transfers/:id/revoke {reason}   the sender, before it's decided
//   POST …/transfers/receive/preview {code}
//   POST …/transfers/receive/accept {code, campusId (schools)}   creates a new learner with the records attached
//   POST …/transfers/receive/decline {code, reason}
//   GET  …/learners/:id/transferred-records
//   POST …/transferred-records/:id/void {reason}
//
// Nothing transfers on its own: a person on each side acts, the sender's
// records stay put, and what arrives is labelled with where it came from.
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { rows, one, validId, cleanText, HttpError } from "./role-app-util.js";
import { family } from "./homeschool-routes.js";
import { school } from "./private-school-routes.js";

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const PURPOSES = ["enrollment", "records_request", "return_to_homeschool", "other"];
const CODE = /^[A-Za-z0-9_-]{30,100}$/;
const STATUS = { invitation_not_valid: 404, transfer_code_not_valid: 404, transfer_not_found: 404, learner_not_found: 404, record_not_found: 404,
  full_authority_required: 403, registrar_or_admin_only: 403, family_owner_only: 403, guardian_of_this_learner_only: 403, school_not_verified: 409,
  same_family_or_school: 409, already_decided: 409, not_awaiting_release: 409, already_voided: 409 };
const check = out => { if (!out.ok) throw new HttpError(STATUS[out.error] ?? 400, out.error, out.allowed ? { allowed: out.allowed } : undefined); return out; };
const code = body => { const c = body?.code; if (typeof c !== "string" || !CODE.test(c.trim())) throw new HttpError(400, "invalid_code"); return sha256(c.trim()); };
const reason = (v, min = 3) => { if (!cleanText(v, 300, min)) throw new HttpError(400, "reason_required"); return v.trim(); };
const newCode = () => crypto.randomBytes(32).toString("base64url");

const transferOut = (t, here) => ({ id: t.id, direction: t.source_tenant === here ? "sent" : "received", learner: t.snapshot?.learner?.displayName, from: t.source_label, to: t.receiver_label,
  purpose: t.purpose, note: t.note, sections: t.sections, status: t.status === "ready" && t.expires_at && new Date(t.expires_at) < new Date() ? "expired" : t.status,
  items: t.snapshot?.items?.length ?? 0, sha256: t.sha256, preparedAt: t.prepared_at, releasedAt: t.released_at, expiresAt: t.expires_at, decidedAt: t.decided_at,
  declineReason: t.decline_reason, revokeReason: t.revoke_reason, sourceLearnerId: t.source_tenant === here ? t.source_learner : undefined,
  receiverLearnerId: t.receiver_tenant === here ? t.receiver_learner : undefined });
const recordOut = r => ({ id: r.id, transferId: r.transfer_id, kind: r.kind, title: r.title, detail: r.detail, provenance: r.provenance, receivedAt: r.received_at,
  voided: !!r.voided_at, voidReason: r.void_reason });

function routes(app, base, wrap, here, learnerColumn) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `xfer:${req.actor?.userId}` });
  app.get(`${base}/transfers`, requireSession, wrap(async (c, req) =>
    (await rows(c, `SELECT id, source_kind, source_tenant, source_learner, source_label, purpose, note, sections, snapshot, sha256, status, prepared_at, released_at, expires_at,
        receiver_kind, receiver_tenant, receiver_label, receiver_learner, decided_at, decline_reason, revoke_reason FROM learner_transfers ORDER BY prepared_at DESC LIMIT 100`)).map(t => transferOut(t, here(req)))));
  app.post(`${base}/transfers`, limiter, requireSession, requireCsrf, wrap(async (c, req) => {
    const b = req.body || {}, sections = Array.isArray(b.sections) ? [...new Set(b.sections)] : [];
    if (!validId(b.learnerId) || !PURPOSES.includes(b.purpose) || !sections.length || sections.some(x => typeof x !== "string") || (b.note != null && (typeof b.note !== "string" || b.note.length > 500)))
      throw new HttpError(400, "invalid_transfer", { hint: "learnerId, purpose (enrollment, records_request, return_to_homeschool, other), sections, note" });
    const token = newCode();
    const out = check((await one(c, "SELECT eduos_transfer_prepare($1,$2,$3,$4,$5) AS out", [b.learnerId, b.purpose, sections, b.note ?? null, sha256(token)])).out);
    return out.status === "ready"
      ? { id: out.id, status: out.status, items: out.items, code: token, note: "Shown once. Give this code only to the school or family that should receive these records. It works for 14 days." }
      : { id: out.id, status: out.status, items: out.items, note: "A guardian with full authority has to release it before anyone can receive it." };
  }, 201));
  app.post(`${base}/transfers/:id/revoke`, limiter, requireSession, requireCsrf, wrap(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    return check((await one(c, "SELECT eduos_transfer_revoke($1,$2) AS out", [req.params.id, reason(req.body?.reason)])).out) && { revoked: true };
  }));
  app.post(`${base}/transfers/receive/preview`, limiter, requireSession, requireCsrf, wrap(async (c, req) => {
    const p = check((await one(c, "SELECT eduos_transfer_preview($1) AS out", [code(req.body)])).out);
    return { id: p.id, from: p.from, fromKind: p.fromKind, purpose: p.purpose, note: p.note, sections: p.sections, learner: p.snapshot.learner, provenance: p.snapshot.provenance,
      items: p.snapshot.items, sha256: p.sha256, expiresAt: p.expiresAt };
  }));
  app.post(`${base}/transfers/receive/accept`, limiter, requireSession, requireCsrf, wrap(async (c, req) => {
    const campus = req.body?.campusId ?? null;
    if (campus != null && !validId(campus)) throw new HttpError(400, "invalid_id");
    const out = check((await one(c, "SELECT eduos_transfer_accept($1,$2) AS out", [code(req.body), campus])).out);
    return { transferId: out.id, learnerId: out.learnerId, records: out.records };
  }));
  app.post(`${base}/transfers/receive/decline`, limiter, requireSession, requireCsrf, wrap(async (c, req) =>
    check((await one(c, "SELECT eduos_transfer_decline($1,$2) AS out", [code(req.body), reason(req.body?.reason)])).out) && { declined: true }));
  app.get(`${base}/learners/:id/transferred-records`, requireSession, wrap(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    return (await rows(c, `SELECT * FROM transferred_records WHERE ${learnerColumn}=$1 ORDER BY kind, title`, [req.params.id])).map(recordOut);
  }));
  app.post(`${base}/transferred-records/:id/void`, limiter, requireSession, requireCsrf, wrap(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    return check((await one(c, "SELECT eduos_transferred_record_void($1,$2) AS out", [req.params.id, reason(req.body?.reason)])).out) && { voided: true };
  }));
}

export function registerLearnerTransferRoutes(app) {
  // The guardian's release comes first so "receive" isn't read as an id.
  app.post("/api/private-school/transfers/:id/release", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `xfer-r:${req.actor?.userId}` }),
    requireSession, requireCsrf, school(async (c, req) => {
      if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
      const token = newCode();
      const out = check((await one(c, "SELECT eduos_transfer_release($1,$2) AS out", [req.params.id, sha256(token)])).out);
      return { id: out.id, code: token, expiresAt: out.expiresAt, note: "Shown once. Give this code only to the school or family that should receive these records." };
    }));
  routes(app, "/api/homeschool", family, req => req.actor.familyId, "family_learner_id");
  routes(app, "/api/private-school", school, req => req.actor.privateSchoolId, "ps_learner_id");
}
