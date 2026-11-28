// Guardian relationship revocation (db/182). The student's school leaders (the
// principal or vice principal) and the superintendent see a student's family
// links and can end a parent's or guardian's link, with a reason, or restore
// it. Every family view of that child stops at once, because each one checks
// for an active link. A court order or do-not-release instruction still goes
// in pick-up restrictions (src/pickup-routes.js); ending a link stops portal
// access, it doesn't stop a release at the curb.
//
//   GET  /api/students/:studentId/guardians
//   POST /api/students/:studentId/guardians/:userId/disable {reason}
//   POST /api/students/:studentId/guardians/:userId/enable {reason}
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";

const LEADS = ["principal", "vice_principal", "superintendent"];

export function registerGuardianLinkRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `gl:${req.actor?.userId}` });
  const run = fn => async (req, res, next) => {
    try {
      if (req.actor?.tenantKind && req.actor.tenantKind !== "district") throw new HttpError(403, "district_context_required");
      if (!LEADS.includes(req.actor.role)) throw new HttpError(403, "school_leaders_only");
      if (!validId(req.params.studentId) || (req.params.userId !== undefined && !validId(req.params.userId))) throw new HttpError(400, "invalid_id");
      const data = await withTenantTransaction(req.actor, async c => {
        const st = await one(c, "SELECT id, school_id, display_name FROM students WHERE id=$1", [req.params.studentId]);
        if (!st || (req.actor.role !== "superintendent" && st.school_id !== req.actor.schoolId)) throw new HttpError(404, "student_not_found");
        return fn(c, req, st);
      });
      res.setHeader("Cache-Control", "no-store"); res.json({ data });
    } catch (e) { sendError(res, next, e); }
  };
  const change = enable => run(async (c, req, st) => {
    const reason = req.body?.reason;
    if (!cleanText(reason, 500, 3)) throw new HttpError(400, "reason_required");
    const r = await one(c, `UPDATE student_user_links SET status=$3,
        disabled_by=CASE WHEN $3='disabled' THEN $4::uuid END, disabled_at=CASE WHEN $3='disabled' THEN now() END, disabled_reason=CASE WHEN $3='disabled' THEN $5 END
      WHERE student_id=$1 AND user_id=$2 AND relationship IN ('parent','guardian') AND status<>$3 RETURNING relationship`,
      [st.id, req.params.userId, enable ? "active" : "disabled", req.actor.userId, reason.trim()]);
    if (!r) throw new HttpError(404, enable ? "no_disabled_guardian_link" : "no_active_guardian_link");
    await audit(c, req, enable ? "enable_guardian_link" : "disable_guardian_link", "student", st.id, `guardian=${req.params.userId};${reason.trim().slice(0, 200)}`);
    return { studentId: st.id, userId: req.params.userId, status: enable ? "active" : "disabled",
      ...(enable ? {} : { note: "Portal access for this child ended. For a court order or do-not-release instruction, also add a pick-up restriction." }) };
  });

  app.get("/api/students/:studentId/guardians", requireSession, run(async (c, req, st) =>
    (await rows(c, `SELECT l.user_id, u.display_name, l.relationship, l.status, l.disabled_at, l.disabled_reason
        FROM student_user_links l JOIN users u ON u.id=l.user_id WHERE l.student_id=$1 AND l.relationship IN ('parent','guardian') ORDER BY l.status, u.display_name`, [st.id]))
      .map(l => ({ userId: l.user_id, name: l.display_name, relationship: l.relationship, status: l.status, disabledAt: l.disabled_at, disabledReason: l.disabled_reason }))));
  app.post("/api/students/:studentId/guardians/:userId/disable", limiter, requireSession, requireCsrf, change(false));
  app.post("/api/students/:studentId/guardians/:userId/enable", limiter, requireSession, requireCsrf, change(true));
}
