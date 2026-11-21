// TC-02: parent/guardian family-memory contributions with school review.
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";

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
  const student = await one(client, `
    SELECT s.id, s.school_id, s.display_name
      FROM students s
     WHERE s.id=$1 AND s.district_id=$2
       AND ($3::uuid IS NULL OR s.school_id=$3)
     ${lock ? "FOR UPDATE" : ""}
  `, [studentId, actor.districtId, isDistrictLead(actor.role) ? null : actor.schoolId]);
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
      return (await client.query(`
        SELECT id, title, body, occurred_at, status, review_note, created_at, reviewed_at
          FROM student_history_contributions
         WHERE district_id=$1 AND student_id=$2 AND guardian_user_id=$3
         ORDER BY created_at DESC, id DESC
         LIMIT 100
      `, [req.actor.districtId, req.params.studentId, req.actor.userId])).rows;
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

  app.get("/api/students/:studentId/history-contributions",
    requireSession, wrap(async (client, req) => {
      if (!canReview(req.actor.role)) throw new HttpError(403, "school_reviewer_required");
      await linkedStudent(client, req.actor, req.params.studentId);
      return (await client.query(`
        SELECT c.id, c.title, c.body, c.occurred_at, c.status, c.created_at,
               c.guardian_user_id, u.display_name AS guardian_name
          FROM student_history_contributions c
          JOIN users u ON u.id=c.guardian_user_id
         WHERE c.district_id=$1 AND c.student_id=$2
           AND c.status='submitted'
         ORDER BY c.created_at, c.id
         LIMIT 100
      `, [req.actor.districtId, req.params.studentId])).rows;
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
          let historyEntryId = null;
          if (body.decision === "approve") {
            const entry = await one(client, `
              INSERT INTO student_history_entries
                (district_id, school_id, student_id, entry_type, classification,
                 title, body, occurred_at, audience, status, source_type, author_user_id)
              VALUES ($1,$2,$3,'reflection','family_memory',$4,$5,$6,'family','published','guardian',$7)
              RETURNING id
            `, [actor.districtId, student.school_id, student.id, contribution.title,
              contribution.body, contribution.occurred_at, contribution.guardian_user_id]);
            historyEntryId = entry.id;
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
          await client.query(`
            INSERT INTO student_history_contribution_events
              (district_id, school_id, student_id, contribution_id, actor_user_id, event_type, detail)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
          `, [actor.districtId, student.school_id, student.id, contribution.id,
            actor.userId, status, (body.note || "").trim() || null]);
          await audit(client, req, status, "student_history_contribution", contribution.id);
          return updated;
        });
        res.setHeader("Cache-Control", "no-store");
        res.json({ data: result });
      } catch (error) { sendError(res, next, error); }
    });
}
