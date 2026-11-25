// TC-02: parent/guardian family-memory contributions with school review.
import { randomUUID } from "node:crypto";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { historyMedia } from "./history-media-routes.js";

// MEDIA-02: each contribution's ready photos (for its guardian or the reviewer).
async function withPhotos(client, list) {
  if (!list.length) return list;
  const ids = list.map(c => c.id);
  const [photos, documents] = await Promise.all([
    client.query(`SELECT * FROM eduos_history_contribution_photos($1::uuid[])`, [ids]),
    client.query(`SELECT * FROM eduos_history_contribution_documents($1::uuid[])`, [ids])
  ]);
  return list.map(c => ({ ...c,
    photos: photos.rows.filter(p => p.contribution_id === c.id).map(p => ({ id: p.asset_id, caption: p.caption, alt: p.alt_text, width: p.width, height: p.height })),
    documents: documents.rows.filter(d => d.contribution_id === c.id).map(d => ({ id: d.asset_id, fileName: d.file_name, bytes: Number(d.byte_size), href: `/api/history/documents/${d.asset_id}` }))
  }));
}
// A rejected or withdrawn contribution's photos stop counting and leave the bucket (best effort; a failure leaves an unreachable object).
async function releasePhotos(client, contributionId) {
  const [photos, documents] = await Promise.all([
    client.query(`SELECT storage_key FROM eduos_history_contribution_photos_release($1)`, [contributionId]),
    client.query(`SELECT storage_key FROM eduos_history_contribution_documents_release($1)`, [contributionId])
  ]);
  return [...photos.rows, ...documents.rows].map(r => r.storage_key);
}
function deleteReleased(keys) {
  const { storage } = historyMedia();
  if (!storage || !keys.length) return;
  Promise.allSettled(keys.map(k => storage.remove(k))).then(rs => {
    const failed = rs.filter(r => r.status === "rejected").length;
    if (failed) console.error("History photo cleanup failed", { failed });
  });
}

const isDistrictLead = role => role === "superintendent";
const canReview = role => role === "principal" || role === "superintendent";
const wrap = fn => async (req, res, next) => {
  try {
    const data = await withTenantTransaction(req.actor, client => fn(client, req));
    res.setHeader("Cache-Control", "no-store");
    res.json({ data });
  } catch (error) { sendError(res, next, error); }
};
async function linkedStudent(client, actor, studentId, lock = false) {
  if (!validId(studentId)) throw new HttpError(400, "invalid_student_id");
  const student = await one(client, `
    SELECT s.id, s.school_id, s.display_name
      FROM students s
     WHERE s.id=$1 AND s.district_id=$2
       AND ($3::uuid IS NULL OR s.school_id=$3)
     ${lock ? "FOR UPDATE" : ""}
  `, [studentId, actor.districtId, (isDistrictLead(actor.role) || actor.role === "parent") ? null : actor.schoolId]);
  if (!student) throw new HttpError(404, "student_not_found");
  if (actor.role === "parent") {
    const link = await one(client, `
      SELECT 1 FROM student_user_links
       WHERE district_id=$1 AND student_id=$2 AND user_id=$3
         AND status='active' AND relationship IN ('parent','guardian')
       LIMIT 1
    `, [actor.districtId, studentId, actor.userId]);
    if (!link) throw new HttpError(404, "linked_student_not_found");
  } else if (!canReview(actor.role)) {
    throw new HttpError(403, "guardian_or_school_reviewer_required");
  }
  return student;
}

export function registerStudentHistoryContributionRoutes(app) {
  app.get("/api/family/children/:studentId/history-contributions",
    requireSession, wrap(async (client, req) => {
      if (req.actor.role !== "parent") throw new HttpError(403, "guardian_role_required");
      await linkedStudent(client, req.actor, req.params.studentId);
      return withPhotos(client, (await client.query(`
        SELECT id, title, body, occurred_at, status, review_note, created_at, reviewed_at
          FROM student_history_contributions
         WHERE district_id=$1 AND student_id=$2 AND guardian_user_id=$3
         ORDER BY created_at DESC, id DESC
         LIMIT 100
      `, [req.actor.districtId, req.params.studentId, req.actor.userId])).rows);
    }));

  app.post("/api/family/children/:studentId/history-contributions",
    requireSession, requireCsrf, async (req, res, next) => {
      const actor = req.actor, body = req.body || {};
      if (actor.role !== "parent") return res.status(403).json({ error: "guardian_role_required" });
      if (!validId(req.params.studentId) || !cleanText(body.title, 180) ||
          !cleanText(body.body ?? "", 12000, 0) ||
          typeof body.occurredAt !== "string" || !Number.isFinite(Date.parse(body.occurredAt)) ||
          Object.keys(body).some(key => !["title", "body", "occurredAt"].includes(key))) {
        return res.status(400).json({ error: "invalid_history_contribution" });
      }
      try {
        const result = await withTenantTransaction(actor, async client => {
          const student = await linkedStudent(client, actor, req.params.studentId, true);
          const contribution = await one(client, `
            INSERT INTO student_history_contributions
              (district_id, school_id, student_id, guardian_user_id, title, body, occurred_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            RETURNING id, title, body, occurred_at, status, created_at
          `, [actor.districtId, student.school_id, student.id, actor.userId,
            body.title.trim(), (body.body || "").trim(), new Date(body.occurredAt).toISOString()]);
          await client.query(`
            INSERT INTO student_history_contribution_events
              (district_id, school_id, student_id, contribution_id, actor_user_id, event_type)
            VALUES ($1,$2,$3,$4,$5,'submitted')
          `, [actor.districtId, student.school_id, student.id, contribution.id, actor.userId]);
          await audit(client, req, "submit", "student_history_contribution", contribution.id);
          return contribution;
        });
        res.setHeader("Cache-Control", "no-store");
        res.status(201).json({ data: result });
      } catch (error) { sendError(res, next, error); }
    });

  app.patch("/api/family/children/:studentId/history-contributions/:contributionId",
    requireSession, requireCsrf, async (req, res, next) => {
      const actor = req.actor, body = req.body || {};
      if (actor.role !== "parent") return res.status(403).json({ error: "guardian_role_required" });
      if (!validId(req.params.studentId) || !validId(req.params.contributionId) ||
          body.decision !== "withdraw" || Object.keys(body).some(key => key !== "decision")) {
        return res.status(400).json({ error: "invalid_contribution_withdrawal" });
      }
      try {
        const result = await withTenantTransaction(actor, async client => {
          const student = await linkedStudent(client, actor, req.params.studentId, true);
          const contribution = await one(client, `
            SELECT id, status FROM student_history_contributions
             WHERE id=$1 AND district_id=$2 AND school_id=$3
               AND student_id=$4 AND guardian_user_id=$5
             FOR UPDATE
          `, [req.params.contributionId, actor.districtId, student.school_id, student.id, actor.userId]);
          if (!contribution || contribution.status !== "submitted")
            throw new HttpError(404, "pending_contribution_not_found");
          const updated = await one(client, `
            UPDATE student_history_contributions
               SET status='withdrawn', updated_at=now()
             WHERE id=$1 AND status='submitted'
             RETURNING id, status, updated_at
          `, [contribution.id]);
          if (!updated) throw new HttpError(409, "contribution_already_reviewed");
          updated.released = await releasePhotos(client, contribution.id);
          await client.query(`
            INSERT INTO student_history_contribution_events
              (district_id, school_id, student_id, contribution_id, actor_user_id, event_type)
            VALUES ($1,$2,$3,$4,$5,'withdrawn')
          `, [actor.districtId, student.school_id, student.id, contribution.id, actor.userId]);
          await audit(client, req, "withdraw", "student_history_contribution", contribution.id);
          return updated;
        });
        const { released = [], ...out } = result;
        deleteReleased(released);
        res.setHeader("Cache-Control", "no-store");
        res.json({ data: out });
      } catch (error) { sendError(res, next, error); }
    });

  app.get("/api/history-contributions",
    requireSession, wrap(async (client, req) => {
      if (!canReview(req.actor.role)) throw new HttpError(403, "school_reviewer_required");
      return withPhotos(client, (await client.query(`
        SELECT c.id, c.student_id, c.school_id, s.display_name AS student_name,
               c.title, c.body, c.occurred_at, c.created_at,
               c.guardian_user_id, u.display_name AS guardian_name
          FROM student_history_contributions c
          JOIN students s ON s.id=c.student_id AND s.district_id=c.district_id
          JOIN users u ON u.id=c.guardian_user_id
         WHERE c.district_id=$1 AND c.status='submitted'
         ORDER BY c.created_at, c.id
         LIMIT 200
      `, [req.actor.districtId])).rows);
    }));

  app.get("/api/students/:studentId/history-contributions",
    requireSession, wrap(async (client, req) => {
      if (!canReview(req.actor.role)) throw new HttpError(403, "school_reviewer_required");
      await linkedStudent(client, req.actor, req.params.studentId);
      return withPhotos(client, (await client.query(`
        SELECT c.id, c.title, c.body, c.occurred_at, c.status, c.created_at,
               c.guardian_user_id, u.display_name AS guardian_name
          FROM student_history_contributions c
          JOIN users u ON u.id=c.guardian_user_id
         WHERE c.district_id=$1 AND c.student_id=$2
           AND c.status='submitted'
         ORDER BY c.created_at, c.id
         LIMIT 100
      `, [req.actor.districtId, req.params.studentId])).rows);
    }));

  app.patch("/api/students/:studentId/history-contributions/:contributionId",
    requireSession, requireCsrf, async (req, res, next) => {
      const actor = req.actor, body = req.body || {};
      if (!canReview(actor.role)) return res.status(403).json({ error: "school_reviewer_required" });
      if (!validId(req.params.studentId) || !validId(req.params.contributionId) ||
          !["approve", "reject"].includes(body.decision) ||
          (body.note !== undefined && !cleanText(body.note, 1000, 0)) ||
          Object.keys(body).some(key => !["decision", "note"].includes(key))) {
        return res.status(400).json({ error: "invalid_contribution_review" });
      }
      try {
        const result = await withTenantTransaction(actor, async client => {
          const student = await linkedStudent(client, actor, req.params.studentId, true);
          const contribution = await one(client, `
            SELECT * FROM student_history_contributions
             WHERE id=$1 AND district_id=$2 AND school_id=$3 AND student_id=$4
             FOR UPDATE
          `, [req.params.contributionId, actor.districtId, student.school_id, student.id]);
          if (!contribution || contribution.status !== "submitted")
            throw new HttpError(404, "pending_contribution_not_found");
          if (contribution.guardian_user_id === actor.userId)
            throw new HttpError(403, "contribution_self_review_forbidden");
          let historyEntryId = null;
          if (body.decision === "approve") {
            // The id is made here, not read back: a reviewer can publish a
            // family memory in the guardian's name but can't read family
            // memories (db/088), so RETURNING would be refused.
            historyEntryId = randomUUID();
            await client.query(`
              INSERT INTO student_history_entries
                (id, district_id, school_id, student_id, entry_type, classification,
                 title, body, occurred_at, audience, status, source_type, author_user_id)
              VALUES ($1,$2,$3,$4,'reflection','family_memory',$5,$6,$7,'family','published','guardian',$8)
            `, [historyEntryId, actor.districtId, student.school_id, student.id, contribution.title,
              contribution.body, contribution.occurred_at, contribution.guardian_user_id]);
          }
          const status = body.decision === "approve" ? "approved" : "rejected";
          const updated = await one(client, `
            UPDATE student_history_contributions
               SET status=$2, reviewed_by=$3, reviewed_at=now(),
                   review_note=$4, history_entry_id=$5, updated_at=now()
             WHERE id=$1 AND status='submitted'
             RETURNING id, status, reviewed_at, history_entry_id
          `, [contribution.id, status, actor.userId, (body.note || "").trim() || null, historyEntryId]);
          if (!updated) throw new HttpError(409, "contribution_already_reviewed");
          // MEDIA-02: approved photos go onto the family memory; rejected ones are released.
          if (status === "approved") updated.photos = (await one(client, `SELECT eduos_history_contribution_photos_publish($1) AS n`, [contribution.id])).n;
          else updated.released = await releasePhotos(client, contribution.id);
          await client.query(`
            INSERT INTO student_history_contribution_events
              (district_id, school_id, student_id, contribution_id, actor_user_id, event_type, detail)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
          `, [actor.districtId, student.school_id, student.id, contribution.id,
            actor.userId, status, (body.note || "").trim() || null]);
          await audit(client, req, status, "student_history_contribution", contribution.id);
          return updated;
        });
        const { released = [], ...out } = result;
        deleteReleased(released);
        res.setHeader("Cache-Control", "no-store");
        res.json({ data: out });
      } catch (error) { sendError(res, next, error); }
    });
}
