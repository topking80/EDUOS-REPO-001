// TC-11: the family storage dashboard (db/133).
//
//   GET /api/history/storage?studentId=     the student, or a linked guardian (no custody
//                                           restriction, before the student holds their own rights)
//
// Explains the district's limits and how much of them the child's history
// uses, what's waiting or was turned down, when Time Capsules open, and how
// to get a copy. Totals come from the server's own accounting (the same sum
// the upload limit checks). It never offers more space for money: donations
// don't change any limit, and the response says so.
import { requireSession } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, HttpError, sendError } from "./role-app-util.js";
import { historyAccess } from "./student-history-portfolio-routes.js";
import { HISTORY_IMAGE_TYPES } from "./history-image.js";

const DEFAULTS = { images_enabled: false, max_image_bytes: 10485760, max_per_entry: 6, max_bytes_per_student: 262144000 };
const MILESTONES = ["grade_5_completion", "grade_8_completion", "graduation", "age_18"];
export const STORAGE_GUIDANCE = [
  "Photos are checked for safety and saved as a smaller copy without location data, so the size counted is usually less than the original.",
  "JPEG, PNG and WebP photos are accepted. A phone photo of 3 to 5 MB is fine; very large images can be resized before uploading.",
  "Deleting a draft or a declined item frees its space. Items accepted into the history stay under the district's records rules.",
  "The limit is the same for every student and is set by the district. It can't be raised by payment or donation."
];

export function registerFamilyStorageRoutes(app) {
  app.get("/api/history/storage", requireSession, async (req, res, next) => {
    if (req.query.studentId !== undefined && !validId(req.query.studentId)) return res.status(400).json({ error: "invalid_student_id" });
    try {
      const data = await withTenantTransaction(req.actor, async c => {
        const { student, access } = await historyAccess(c, req.actor, req.query.studentId);
        if (!["student", "guardian"].includes(access)) throw new HttpError(403, "family_only");
        let usage;
        try { usage = await one(c, `SELECT * FROM eduos_history_family_storage($1)`, [student.id]); }
        catch (e) { if (e.code === "P0002") throw new HttpError(404, "student_not_found"); throw e; }
        const pol = (await one(c, `SELECT * FROM district_history_media_policies WHERE district_id=$1`, [req.actor.districtId])) || DEFAULTS;
        const preservation = await one(c, `SELECT records_schedule_ref FROM district_history_preservation_policies WHERE district_id=$1`, [req.actor.districtId]);
        const items = await rows(c, `SELECT status, count(*)::int AS n FROM student_history_entries WHERE student_id=$1 AND district_id=$2 GROUP BY status`, [student.id, req.actor.districtId]);
        const mine = access === "guardian" ? await rows(c, `SELECT status, count(*)::int AS n FROM student_history_contributions
            WHERE student_id=$1 AND district_id=$2 AND guardian_user_id=$3 GROUP BY status`, [student.id, req.actor.districtId, req.actor.userId]) : [];
        const capsules = await rows(c, `SELECT id,title,status,release_kind,release_at,milestone_key FROM student_time_capsules
            WHERE student_id=$1 AND district_id=$2 AND owner_user_id=$3 AND status<>'cancelled' ORDER BY created_at DESC LIMIT 20`, [student.id, req.actor.districtId, req.actor.userId]);
        await audit(c, req, "read", "history_storage", student.id, `access=${access}`);
        const count = (list, s) => list.find(r => r.status === s)?.n || 0;
        const used = Number(usage.used_bytes), max = Number(pol.max_bytes_per_student);
        return {
          student: { id: student.id, name: student.display_name },
          limits: { photosAllowed: pol.images_enabled, maxPhotoBytes: pol.max_image_bytes, maxPhotosPerItem: pol.max_per_entry, maxBytesPerStudent: max,
            types: Object.keys(HISTORY_IMAGE_TYPES), setBy: "district" },
          usage: { usedBytes: used, percent: max ? Math.min(100, Math.round(used * 1000 / max) / 10) : 0, photos: Number(usage.photos),
            inLongTermStorage: Number(usage.archived_photos), roomForAnotherPhoto: used + pol.max_image_bytes <= max },
          items: { inHistory: count(items, "published") + count(items, "archived"), waitingForReview: count(items, "submitted") + count(items, "approved"), drafts: count(items, "draft") },
          ...(access === "guardian" ? { myContributions: { waiting: count(mine, "submitted"), accepted: count(mine, "approved"), declined: count(mine, "rejected"), withdrawn: count(mine, "withdrawn") } } : {}),
          capsules: capsules.map(x => ({ id: x.id, title: x.title, status: x.status, opens: x.release_kind === "scheduled" ? { on: x.release_at } : { milestone: MILESTONES.includes(x.milestone_key) ? x.milestone_key : "other" } })),
          retention: { recordsScheduleRef: preservation?.records_schedule_ref || "",
            text: "Official school records are kept by the district under its records schedule. Family memories and portfolio items stay while the history is kept; you can download a copy at any time." },
          export: { allowed: true, href: `/api/history/export?studentId=${student.id}` },
          guidance: STORAGE_GUIDANCE,
          donations: { changeStorage: false, text: "Donations, if your district accepts them, help pay for preserving everyone's history. They never change this limit, what's kept, or who can see it." }
        };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });
}
