// Time Capsules: a family member, the student, a teacher or a school lead puts
// history items in a capsule for the student, names who should receive it,
// seals it, and it opens on a date or when the school confirms a milestone,
// for recipients who accepted. Who may do what is enforced by the database
// (db/088, db/091); these routes validate input and map outcomes.
import { randomUUID } from "node:crypto";
import { requireSession, requireCsrf } from "./auth.js";
import { pool, withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { audit, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";

export const MILESTONES = ["grade_5_completion", "grade_8_completion", "graduation", "age_18"];
const RECIPIENT_TYPES = ["student", "guardian", "teacher", "school_staff"];
const PG_ERRORS = { P0002: 404, "55000": 409, "42501": 403, "22023": 400 };

function mapError(error) {
  if (error instanceof HttpError) return error;
  const status = PG_ERRORS[error?.code];
  if (!status) return error;
  const code = /^[a-z_]+$/.test(error.message || "") ? error.message : status === 403 ? "forbidden" : "invalid_request";
  return new HttpError(status, code);
}
const handler = fn => async (req, res, next) => {
  try {
    const data = await withTenantTransaction(req.actor, client => fn(client, req));
    res.setHeader("Cache-Control", "no-store");
    res.status(data?.created ? 201 : 200).json({ data: data?.created ?? data });
  } catch (error) { sendError(res, next, mapError(error)); }
};
const onlyKeys = (b, keys) => b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).every(k => keys.includes(k));
const validTimezone = tz => typeof tz === "string" && tz.length <= 64 && (() => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } })();
// Row-level security refusals on insert mean "not yours to do".
async function guarded(client, code, fn) {
  await client.query("SAVEPOINT guarded");
  try { const r = await fn(); await client.query("RELEASE SAVEPOINT guarded"); return r; }
  catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT guarded");
    if (e?.code === "42501") throw new HttpError(404, code);
    throw e;
  }
}
const capsuleView = c => ({ id: c.id, studentId: c.student_id, studentName: c.student_name, title: c.title, message: c.message, status: c.status,
  releaseKind: c.release_kind, releaseAt: c.release_at, milestone: c.milestone_key, timezone: c.timezone, mine: c.mine,
  sealedAt: c.sealed_at, releasedAt: c.released_at, cancelledAt: c.cancelled_at, createdAt: c.created_at });

export function registerStudentHistoryCapsuleRoutes(app) {
  // Mine, and those released to me.
  app.get("/api/history/capsules", requireSession, handler(async (client, req) => {
    if (req.query.studentId !== undefined && !validId(req.query.studentId)) throw new HttpError(400, "invalid_student_id");
    const rows = (await client.query(`
      SELECT c.*, s.display_name AS student_name, (c.owner_user_id=$1) AS mine
        FROM student_time_capsules c JOIN students s ON s.id=c.student_id AND s.district_id=c.district_id
       WHERE ($2::uuid IS NULL OR c.student_id=$2) ORDER BY c.created_at DESC LIMIT 200`, [req.actor.userId, req.query.studentId ?? null])).rows;
    return rows.map(capsuleView);
  }));

  app.post("/api/history/capsules", requireSession, requireCsrf, handler(async (client, req) => {
    const b = req.body;
    const kind = b?.releaseKind;
    if (!onlyKeys(b, ["studentId", "title", "message", "releaseKind", "releaseAt", "milestone", "timezone"]) || !validId(b.studentId)
        || !cleanText(b.title, 180) || !cleanText(b.message ?? "", 12000, 0) || !["scheduled", "milestone"].includes(kind)
        || (kind === "scheduled" && (typeof b.releaseAt !== "string" || !(Date.parse(b.releaseAt) > Date.now())))
        || (kind === "milestone" && !MILESTONES.includes(b.milestone))
        || (b.timezone !== undefined && !validTimezone(b.timezone)))
      throw new HttpError(400, "invalid_capsule");
    const student = await one(client, "SELECT id, school_id FROM students WHERE id=$1 AND district_id=$2", [b.studentId, req.actor.districtId]);
    if (!student) throw new HttpError(404, "student_not_found");
    const id = randomUUID();
    await guarded(client, "student_not_found", () => client.query(`
      INSERT INTO student_time_capsules(id,district_id,school_id,student_id,owner_user_id,title,message,release_kind,release_at,milestone_key,timezone)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, req.actor.districtId, student.school_id, student.id, req.actor.userId, b.title.trim(), (b.message ?? "").trim(), kind,
        kind === "scheduled" ? b.releaseAt : null, kind === "milestone" ? b.milestone : null, b.timezone ?? "UTC"]));
    await audit(client, req, "create", "time_capsule", id);
    return { created: { id, status: "draft" } };
  }));

  app.get("/api/history/capsules/:id", requireSession, handler(async (client, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_capsule_id");
    const c = await one(client, `SELECT c.*, s.display_name AS student_name, (c.owner_user_id=$2) AS mine
        FROM student_time_capsules c JOIN students s ON s.id=c.student_id AND s.district_id=c.district_id WHERE c.id=$1`, [req.params.id, req.actor.userId]);
    if (!c) throw new HttpError(404, "capsule_not_found");
    const items = (await client.query("SELECT * FROM eduos_capsule_contents($1)", [c.id])).rows.map(i => ({
      position: i.item_position, entryId: i.entry_id, withheld: i.withheld, entryType: i.entry_type, kind: i.classification,
      title: i.title, body: i.body, occurredAt: i.occurred_at, addedAt: i.added_at }));
    const out = { ...capsuleView(c), items };
    if (c.mine) {
      out.recipients = (await client.query(`SELECT r.recipient_user_id, u.display_name, r.recipient_type, r.consent_status
          FROM student_time_capsule_recipients r JOIN users u ON u.id=r.recipient_user_id WHERE r.capsule_id=$1 ORDER BY u.display_name`, [c.id])).rows
        .map(r => ({ userId: r.recipient_user_id, name: r.display_name, type: r.recipient_type, consent: r.consent_status }));
      out.events = (await client.query(`SELECT event_type, outcome, reason_code, occurred_at FROM student_time_capsule_events
          WHERE capsule_id=$1 ORDER BY occurred_at`, [c.id])).rows.map(e => ({ type: e.event_type, outcome: e.outcome, reason: e.reason_code, at: e.occurred_at }));
    }
    return out;
  }));

  app.patch("/api/history/capsules/:id", requireSession, requireCsrf, handler(async (client, req) => {
    const b = req.body;
    if (!validId(req.params.id) || !onlyKeys(b, ["title", "message"]) || (b.title === undefined && b.message === undefined)
        || (b.title !== undefined && !cleanText(b.title, 180)) || (b.message !== undefined && !cleanText(b.message, 12000, 0)))
      throw new HttpError(400, "invalid_capsule");
    const r = await client.query(`UPDATE student_time_capsules SET title=coalesce($2,title), message=coalesce($3,message), updated_at=now()
        WHERE id=$1 AND owner_user_id=$4 AND status='draft'`, [req.params.id, b.title?.trim() ?? null, b.message?.trim() ?? null, req.actor.userId]);
    if (!r.rowCount) throw new HttpError(404, "draft_capsule_not_found");
    return { id: req.params.id };
  }));

  // History items the owner can still add (entries they can see, not yet in it).
  app.get("/api/history/capsules/:id/candidates", requireSession, handler(async (client, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_capsule_id");
    const c = await one(client, "SELECT id, student_id FROM student_time_capsules WHERE id=$1 AND owner_user_id=$2 AND status='draft'", [req.params.id, req.actor.userId]);
    if (!c) throw new HttpError(404, "draft_capsule_not_found");
    return (await client.query(`SELECT e.id, e.title, e.entry_type, e.classification, e.occurred_at FROM student_history_entries e
        WHERE e.student_id=$1 AND e.status='published'
          AND NOT EXISTS (SELECT 1 FROM student_time_capsule_items i WHERE i.capsule_id=$2 AND i.entry_id=e.id)
        ORDER BY e.occurred_at DESC LIMIT 200`, [c.student_id, c.id])).rows
      .map(e => ({ id: e.id, title: e.title, entryType: e.entry_type, kind: e.classification, occurredAt: e.occurred_at }));
  }));

  // School leads: milestone capsules waiting for the milestone to be confirmed.
  app.get("/api/history/capsule-milestones", requireSession, handler(async client =>
    (await client.query("SELECT * FROM eduos_capsule_milestones_pending()")).rows.map(r => ({
      capsuleId: r.capsule_id, studentId: r.student_id, studentName: r.student_name, from: r.from_name,
      milestone: r.milestone_key, sealedAt: r.sealed_at, accepted: r.accepted }))));

  // Who the owner may name as recipients.
  app.get("/api/history/capsule-recipient-options", requireSession, handler(async (client, req) => {
    if (!validId(req.query.studentId)) throw new HttpError(400, "invalid_student_id");
    return (await client.query("SELECT * FROM eduos_capsule_recipient_options($1)", [req.query.studentId])).rows
      .map(r => ({ userId: r.user_id, name: r.display_name, type: r.recipient_type }));
  }));

  app.post("/api/history/capsules/:id/items", requireSession, requireCsrf, handler(async (client, req) => {
    if (!validId(req.params.id) || !onlyKeys(req.body, ["entryId"]) || !validId(req.body.entryId)) throw new HttpError(400, "invalid_capsule_item");
    const c = await one(client, "SELECT id, district_id, school_id, student_id, status FROM student_time_capsules WHERE id=$1 AND owner_user_id=$2", [req.params.id, req.actor.userId]);
    if (!c) throw new HttpError(404, "capsule_not_found");
    if (c.status !== "draft") throw new HttpError(409, "capsule_not_a_draft");
    // The entry as it is now; RLS shows only entries the owner can see.
    const e = await one(client, "SELECT id, revision_no FROM student_history_entries WHERE id=$1 AND student_id=$2 AND status='published'", [req.body.entryId, c.student_id]);
    if (!e) throw new HttpError(404, "history_item_not_found");
    const position = (await one(client, "SELECT coalesce(max(position)+1,0)::int AS p FROM student_time_capsule_items WHERE capsule_id=$1", [c.id])).p;
    await guarded(client, "history_item_not_found", () => client.query(`
      INSERT INTO student_time_capsule_items(district_id,school_id,student_id,capsule_id,entry_id,entry_revision_no,position)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [c.district_id, c.school_id, c.student_id, c.id, e.id, e.revision_no, position]));
    await audit(client, req, "item_added", "time_capsule", c.id, e.id);
    return { created: { capsuleId: c.id, entryId: e.id, position } };
  }));

  app.post("/api/history/capsules/:id/recipients", requireSession, requireCsrf, handler(async (client, req) => {
    const b = req.body;
    if (!validId(req.params.id) || !onlyKeys(b, ["userId", "type"]) || !validId(b.userId) || !RECIPIENT_TYPES.includes(b.type))
      throw new HttpError(400, "invalid_capsule_recipient");
    const c = await one(client, "SELECT id, district_id, school_id, student_id FROM student_time_capsules WHERE id=$1 AND owner_user_id=$2", [req.params.id, req.actor.userId]);
    if (!c) throw new HttpError(404, "capsule_not_found");
    await guarded(client, "recipient_not_eligible", () => client.query(`
      INSERT INTO student_time_capsule_recipients(district_id,school_id,student_id,capsule_id,recipient_user_id,recipient_type)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (district_id, capsule_id, recipient_user_id) DO NOTHING`,
      [c.district_id, c.school_id, c.student_id, c.id, b.userId, b.type]));
    await audit(client, req, "recipient_added", "time_capsule", c.id, b.type);
    return { created: { capsuleId: c.id, userId: b.userId, consent: "pending" } };
  }));

  for (const [action, fn] of [["seal", "eduos_capsule_seal"], ["cancel", "eduos_capsule_cancel"], ["release", "eduos_capsule_release_milestone"]]) {
    app.post(`/api/history/capsules/:id/${action}`, requireSession, requireCsrf, handler(async (client, req) => {
      if (!validId(req.params.id)) throw new HttpError(400, "invalid_capsule_id");
      const status = (await one(client, `SELECT ${fn}($1) AS s`, [req.params.id])).s;
      await audit(client, req, action, "time_capsule", req.params.id, status);
      return { id: req.params.id, status };
    }));
  }

  // Recipients: what I've been invited to receive, and my answer.
  app.get("/api/history/capsule-invitations", requireSession, handler(async client =>
    (await client.query("SELECT * FROM eduos_capsule_invitations()")).rows.map(r => ({
      capsuleId: r.capsule_id, studentId: r.student_id, studentName: r.student_name, from: r.from_name, status: r.status,
      releaseKind: r.release_kind, releaseAt: r.release_at, milestone: r.milestone_key, consent: r.consent_status }))));

  app.post("/api/history/capsule-invitations/:capsuleId", requireSession, requireCsrf, handler(async (client, req) => {
    const decision = req.body?.decision;
    if (!validId(req.params.capsuleId) || !onlyKeys(req.body, ["decision"]) || !["approved", "denied", "withdrawn"].includes(decision))
      throw new HttpError(400, "invalid_consent");
    const invited = (await client.query("SELECT status FROM eduos_capsule_invitations() WHERE capsule_id=$1", [req.params.capsuleId])).rows[0];
    if (!invited) throw new HttpError(404, "invitation_not_found");
    if (invited.status === "released" && decision !== "withdrawn") throw new HttpError(409, "capsule_already_released");
    await client.query(`UPDATE student_time_capsule_recipients SET consent_status=$3, updated_at=now()
        WHERE capsule_id=$1 AND recipient_user_id=$2`, [req.params.capsuleId, req.actor.userId, decision]);
    await audit(client, req, `consent.${decision}`, "time_capsule", req.params.capsuleId);
    return { capsuleId: req.params.capsuleId, consent: decision };
  }));
}

/**
 * Release scheduled capsules whose date has come. CAPSULE_RELEASE_INTERVAL_SECONDS
 * (default 300; 0 = off, e.g. when cron runs src/capsule-release-cli.js).
 */
export async function releaseDueCapsules({ db = pool, limit = 100 } = {}) {
  const rows = (await db.query("SELECT * FROM eduos_capsule_release_due($1)", [limit])).rows;
  return { released: rows.filter(r => r.outcome === "released").length, blocked: rows.filter(r => r.outcome === "blocked").length };
}
let releasing = false;
export function startCapsuleReleaseSweep() {
  if (!config.capsuleReleaseIntervalSeconds) return null;
  const timer = setInterval(() => {
    if (releasing) return;
    releasing = true;
    releaseDueCapsules().catch(e => console.error("Time Capsule release sweep failed", { message: e.message })).finally(() => { releasing = false; });
  }, config.capsuleReleaseIntervalSeconds * 1000);
  timer.unref?.();
  return timer;
}
