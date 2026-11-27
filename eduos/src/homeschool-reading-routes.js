// HSP-07 part 2: homeschool reading lists (db/167). Read with any authority
// over the learner; added and updated by the owner or an educator.
//
//   GET   /api/homeschool/learners/:id/reading            the list, with totals
//   POST  /api/homeschool/learners/:id/reading {title, author?, status?, courseId?, notes?}
//   PATCH /api/homeschool/reading/:id {status?, minutes? (added), notes?, finishedOn?}
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { rows, one, validId, cleanText, HttpError } from "./role-app-util.js";
import { family, familyAudit } from "./homeschool-routes.js";

const STATUSES = ["to_read", "reading", "finished", "set_aside"];
const DAY = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const today = () => new Date().toISOString().slice(0, 10);
const ymd = v => v instanceof Date ? v.toISOString().slice(0, 10) : v;
const bookOut = b => ({ id: b.id, title: b.title, author: b.author, status: b.status, startedOn: ymd(b.started_on), finishedOn: ymd(b.finished_on), minutes: b.minutes,
  notes: b.notes, courseId: b.course_id, addedAt: b.added_at });

async function learnerOf(c, id) {
  if (!validId(id)) throw new HttpError(400, "invalid_id");
  const l = await one(c, "SELECT id, eduos_family_can_teach(id) AS teach FROM family_learners WHERE id=$1", [id]);
  if (!l) throw new HttpError(404, "learner_not_found");
  return l;
}

export function registerHomeschoolReadingRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `read:${req.actor?.userId}` });
  app.get("/api/homeschool/learners/:id/reading", requireSession, family(async (c, req) => {
    const l = await learnerOf(c, req.params.id);
    const books = (await rows(c, "SELECT * FROM family_reading WHERE learner_id=$1 ORDER BY status='finished', finished_on DESC NULLS FIRST, added_at DESC LIMIT 500", [l.id])).map(bookOut);
    const year = new Date().getUTCMonth() >= 6 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;
    const since = `${year}-07-01`;
    return { canEdit: l.teach, books, totals: { finishedThisSchoolYear: books.filter(b => b.finishedOn && b.finishedOn >= since).length, reading: books.filter(b => b.status === "reading").length,
      minutes: books.reduce((n, b) => n + b.minutes, 0) } };
  }));
  app.post("/api/homeschool/learners/:id/reading", limiter, requireSession, requireCsrf, family(async (c, req) => {
    const l = await learnerOf(c, req.params.id);
    if (!l.teach) throw new HttpError(403, "not_allowed_for_this_learner");
    const b = req.body || {}, status = b.status || "to_read";
    if (!cleanText(b.title, 200) || (b.author != null && !cleanText(b.author, 120)) || !STATUSES.includes(status) || (b.notes != null && (typeof b.notes !== "string" || b.notes.length > 1000))
      || (b.courseId != null && !validId(b.courseId))) throw new HttpError(400, "invalid_book", { hint: "title, author, status (to_read, reading, finished, set_aside), courseId, notes" });
    if (b.courseId && !(await one(c, "SELECT 1 FROM family_courses WHERE id=$1 AND learner_id=$2", [b.courseId, l.id]))) throw new HttpError(404, "course_not_found");
    const r = await one(c, `INSERT INTO family_reading(family_id, learner_id, title, author, status, started_on, finished_on, notes, course_id, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.actor.familyId, l.id, b.title.trim(), b.author?.trim() ?? null, status, ["reading", "finished"].includes(status) ? today() : null, status === "finished" ? today() : null,
        b.notes ?? null, b.courseId ?? null, req.actor.userId]);
    await familyAudit(c, req, "add", "family_reading", r.id, `learner=${l.id};${status}`);
    return bookOut(r);
  }, 201));
  app.patch("/api/homeschool/reading/:id", limiter, requireSession, requireCsrf, family(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const b0 = await one(c, "SELECT r.*, eduos_family_can_teach(r.learner_id) AS teach FROM family_reading r WHERE r.id=$1", [req.params.id]);
    if (!b0) throw new HttpError(404, "book_not_found");
    if (!b0.teach) throw new HttpError(403, "not_allowed_for_this_learner");
    const b = req.body || {};
    if ((b.status != null && !STATUSES.includes(b.status)) || (b.minutes != null && (!Number.isInteger(b.minutes) || b.minutes < 1 || b.minutes > 1440))
      || (b.notes != null && (typeof b.notes !== "string" || b.notes.length > 1000)) || (b.finishedOn != null && (!DAY(b.finishedOn) || b.finishedOn > today())))
      throw new HttpError(400, "invalid_update", { hint: "status, minutes (to add, 1-1440), notes, finishedOn (not in the future)" });
    const status = b.status ?? b0.status;
    const started = b0.started_on ?? (["reading", "finished"].includes(status) ? today() : null);
    const finished = status === "finished" ? (b.finishedOn ?? ymd(b0.finished_on) ?? today()) : null;
    if (finished && started && finished < ymd(started)) throw new HttpError(400, "finished_before_started");
    const r = await one(c, "UPDATE family_reading SET status=$2, started_on=$3, finished_on=$4, minutes=minutes+$5, notes=coalesce($6, notes) WHERE id=$1 RETURNING *",
      [b0.id, status, started, finished, b.minutes ?? 0, b.notes ?? null]);
    await familyAudit(c, req, "update", "family_reading", r.id, `${status}${b.minutes ? `;+${b.minutes}min` : ""}`);
    return bookOut(r);
  }));
}
