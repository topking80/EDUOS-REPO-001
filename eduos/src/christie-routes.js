// 32.4.0 Christie: hint-first tutoring over APPROVED content only, stored and
// audited on the server. Pupils tutor; teachers (roster) and principals
// (school) review sessions; staff author skills, a principal approves them.
// The provider (src/christie/providers.js) is local and deterministic unless
// an external one is explicitly configured; it never receives identifiers.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { createProvider, outboundHelpFields, helpFieldsText } from "./christie/providers.js";
import { findStudentIdentifiers } from "./student-identifiers.js";

// The adults closest to a learner (linked family and rostered teachers): the
// names a learner is most likely to type, removed before anything leaves for
// an external tutor model. Untitled names of other adults are not known here.
async function peopleAround(client, studentId) {
  const { rows } = await client.query(`
    SELECT u.display_name FROM student_user_links l JOIN users u ON u.id=l.user_id WHERE l.student_id=$1
    UNION SELECT u.display_name FROM teacher_student_rosters r JOIN users u ON u.id=r.teacher_user_id WHERE r.student_id=$1`, [studentId]);
  return rows.map(r => r.display_name).filter(Boolean);
}
import { MESSAGES, MASTERED_AT, pick, isCorrect, classifyQuestion, itemScore, nextMastery } from "./christie/tutor.js";
import { enqueueNotifications } from "./notify.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError, roleIn } from "./role-app-util.js";
import { addEvidence } from "./learning-service.js";

const provider = () => createProvider(config);

async function learnerFor(client, actor) {
  const s = await one(client, `SELECT s.id,s.display_name,s.grade_level,s.school_id FROM student_user_links l JOIN students s ON s.id=l.student_id
      WHERE l.user_id=$1 AND l.status='active' AND l.relationship='pupil' AND s.school_id=$2 ORDER BY s.display_name LIMIT 1`, [actor.userId, actor.schoolId]);
  if (!s) throw new HttpError(403, "no_linked_learner");
  return s;
}
async function nextTurnSeq(client, sessionId) {
  return (await one(client, `SELECT coalesce(max(seq),0)+1 AS n FROM christie_turns WHERE session_id=$1`, [sessionId])).n;
}
async function addTurn(client, session, t) {
  const seq = await nextTurnSeq(client, session.id);
  return one(client, `INSERT INTO christie_turns(district_id,session_id,student_id,seq,speaker,kind,body,item_id,correct,hint_level,provider)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING seq,speaker,kind,body,correct,hint_level,created_at`,
    [session.district_id, session.id, session.student_id, seq, t.speaker, t.kind, String(t.body).slice(0, 2000), t.itemId || null,
     t.correct ?? null, t.hintLevel ?? null, t.provider || null]);
}
async function updateMastery(client, session, score, hintsUsed, actor = null) {
  const prev = await one(client, `SELECT mastery FROM student_skill_mastery WHERE student_id=$1 AND skill_id=$2`, [session.student_id, session.skill_id]);
  const m = nextMastery(prev?.mastery ?? 0, score);
  await client.query(`INSERT INTO student_skill_mastery(district_id,school_id,student_id,skill_id,attempts,correct,hints_used,mastery,mastered_at)
      VALUES($1,$2,$3,$4,1,$5,$6,$7,CASE WHEN $7>=${MASTERED_AT} THEN now() END)
      ON CONFLICT (student_id,skill_id) DO UPDATE SET attempts=student_skill_mastery.attempts+1, correct=student_skill_mastery.correct+$5,
        hints_used=student_skill_mastery.hints_used+$6, mastery=$7,
        mastered_at=CASE WHEN $7>=${MASTERED_AT} THEN coalesce(student_skill_mastery.mastered_at,now()) ELSE student_skill_mastery.mastered_at END, updated_at=now()`,
    [session.district_id, session.school_id, session.student_id, session.skill_id, score > 0 ? 1 : 0, hintsUsed, m]);
  const out = { previous: prev?.mastery ?? 0, mastery: m, mastered: m >= MASTERED_AT };
  // 32.6.0: practice on a skill tied to a standard is also mastery evidence
  // (weight 0.5: practice alone never marks a standard mastered).
  if (actor) {
    const k = await one(client, `SELECT k.standard_id,k.title,ls.code FROM christie_skills k LEFT JOIN learning_standards ls ON ls.id=k.standard_id WHERE k.id=$1`, [session.skill_id]);
    if (k?.standard_id) {
      const r = await addEvidence(client, actor, { schoolId: session.school_id, studentId: session.student_id, standardId: k.standard_id, source: "christie",
        sourceRef: session.id, label: `Christie: ${k.title}`, score });
      out.standard = { code: k.code, mastery: r.mastery, level: r.level, milestone: Boolean(r.milestone) };
    }
  }
  return out;
}
async function serveNextItem(client, session, afterSeq) {
  const item = await one(client, `SELECT * FROM eduos_christie_next_item($1,$2)`, [session.skill_id, afterSeq]);
  if (!item) return null;
  await client.query(`UPDATE christie_sessions SET item_id=$2,hint_level=0,last_activity_at=now() WHERE id=$1`, [session.id, item.item_id]);
  session.item_id = item.item_id; session.hint_level = 0;
  return addTurn(client, session, { speaker: "christie", kind: "item", body: item.prompt, itemId: item.item_id, provider: "rules" });
}
const turnView = t => ({ seq: t.seq, speaker: t.speaker, kind: t.kind, text: t.body, correct: t.correct, hintLevel: t.hint_level, at: t.created_at });
async function sessionView(client, id, { forStaff = false } = {}) {
  const s = await one(client, `SELECT cs.id,cs.status,cs.needs_adult,cs.hint_level,cs.started_at,cs.last_activity_at,cs.reviewed_at,cs.provider,
      k.id AS skill_id,k.title AS skill_title,k.subject,k.code,st.display_name AS student_name,cs.student_id,
      coalesce(m.mastery,0) AS mastery
      FROM christie_sessions cs JOIN christie_skills k ON k.id=cs.skill_id JOIN students st ON st.id=cs.student_id
      LEFT JOIN student_skill_mastery m ON m.student_id=cs.student_id AND m.skill_id=cs.skill_id WHERE cs.id=$1`, [id]);
  if (!s) return null;
  const turns = (await rows(client, `SELECT seq,speaker,kind,body,correct,hint_level,created_at FROM christie_turns WHERE session_id=$1 ORDER BY seq`, [id])).map(turnView);
  const out = { id: s.id, status: s.status, skill: { id: s.skill_id, title: s.skill_title, subject: s.subject, code: s.code }, mastery: s.mastery,
    hintLevel: s.hint_level, startedAt: s.started_at, lastActivityAt: s.last_activity_at, provider: s.provider, turns };
  if (forStaff) Object.assign(out, { studentId: s.student_id, studentName: s.student_name, needsAdult: s.needs_adult, reviewedAt: s.reviewed_at });
  return out;
}

export function registerChristieRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: config.christieRateLimit, standardHeaders: true, legacyHeaders: false });

  // ---- learner: learning path (approved skills for the learner's grade) ----
  app.get("/api/christie/path", requireSession, requirePermission("christie", "tutor"), async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const learner = await learnerFor(client, req.actor);
        // 32.6.0: a skill tied to a standard shows the per-standard mastery model;
        // others keep the 32.4 practice estimate (labelled "practice estimate").
        const skills = await rows(client, `SELECT k.id,k.subject,k.code,k.title,k.sequence,k.grade_level,
              CASE WHEN sm.standard_id IS NOT NULL THEN sm.mastery ELSE coalesce(m.mastery,0) END AS mastery,m.attempts,
              CASE WHEN sm.standard_id IS NOT NULL THEN sm.mastered_at ELSE m.mastered_at END AS mastered_at,
              k.standard_id,ls.code AS standard_code,ls.description AS standard_description,sm.level AS standard_level,
              CASE WHEN sm.standard_id IS NOT NULL THEN 'standard' ELSE 'practice_estimate' END AS mastery_basis,k.lesson_id
            FROM christie_skills k LEFT JOIN student_skill_mastery m ON m.skill_id=k.id AND m.student_id=$1
            LEFT JOIN learning_standards ls ON ls.id=k.standard_id
            LEFT JOIN standard_mastery sm ON sm.standard_id=k.standard_id AND sm.student_id=$1
           WHERE k.status='approved' AND (k.school_id IS NULL OR k.school_id=$2) AND k.grade_level=$3 ORDER BY k.subject,k.sequence,k.title`,
          [learner.id, learner.school_id, learner.grade_level]);
        const counts = new Map((await rows(client, `SELECT * FROM eduos_christie_item_counts($1)`, [skills.map(s => s.id)])).map(c => [c.skill_id, c.items]));
        let currentGiven = new Set();
        for (const s of skills) {
          s.items = counts.get(s.id) || 0;
          if (s.mastery_basis === "standard" ? s.standard_level === "mastered" : s.mastery >= MASTERED_AT) s.state = "mastered";
          else if (!currentGiven.has(s.subject)) { s.state = "current"; currentGiven.add(s.subject); }
          else s.state = "next";
        }
        const recent = await one(client, `SELECT id,skill_id FROM christie_sessions WHERE user_id=$1 AND status='active' ORDER BY last_activity_at DESC LIMIT 1`, [req.actor.userId]);
        await audit(client, req, "read", "christie_path", learner.id, `skills=${skills.length}`);
        return { learner: { name: learner.display_name.split(/\s+/)[0], grade: learner.grade_level }, masteredAt: MASTERED_AT, skills,
          activeSessionId: recent?.id || null, provider: provider().name };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- learner: start (or resume) a session on an approved skill ----
  app.post("/api/christie/sessions", limiter, requireSession, requireCsrf, requirePermission("christie", "tutor"), async (req, res, next) => {
    const { skillId } = req.body || {};
    if (!validId(skillId)) return res.status(400).json({ error: "invalid_skill_id" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const learner = await learnerFor(client, req.actor);
        const skill = await one(client, `SELECT k.id,k.title,ls.code AS standard_code,ls.description AS standard_description FROM christie_skills k
            LEFT JOIN learning_standards ls ON ls.id=k.standard_id WHERE k.id=$1 AND k.status='approved' AND (k.school_id IS NULL OR k.school_id=$2)`, [skillId, learner.school_id]);
        if (!skill) throw new HttpError(404, "skill_not_available");
        const active = await one(client, `SELECT id FROM christie_sessions WHERE user_id=$1 AND skill_id=$2 AND status='active'`, [req.actor.userId, skillId]);
        if (active) return { session: await sessionView(client, active.id), resumed: true };
        const session = await one(client, `INSERT INTO christie_sessions(district_id,school_id,student_id,user_id,skill_id,provider)
            VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [req.actor.districtId, learner.school_id, learner.id, req.actor.userId, skillId, provider().name]);
        await addTurn(client, session, { speaker: "christie", kind: "explanation", body: MESSAGES.greeting(skill.title) + (skill.standard_code ? ` This practice is for standard ${skill.standard_code}: ${skill.standard_description}` : ""), provider: "rules" });
        const item = await serveNextItem(client, session, 0);
        if (!item) throw new HttpError(409, "skill_has_no_items");
        await audit(client, req, "create", "christie_session", session.id, `skill=${skillId}`);
        return { session: await sessionView(client, session.id), resumed: false };
      });
      res.status(data.resumed ? 200 : 201).json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- learner: one turn (attempt | question | skip) ----
  app.post("/api/christie/sessions/:id/turns", limiter, requireSession, requireCsrf, requirePermission("christie", "tutor"), async (req, res, next) => {
    const { kind, text = "" } = req.body || {};
    if (!validId(req.params.id) || !["attempt", "question", "skip"].includes(kind) || (kind !== "skip" && !cleanText(text, 500)))
      return res.status(400).json({ error: "invalid_turn" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const session = await one(client, `SELECT * FROM christie_sessions WHERE id=$1 AND user_id=$2`, [req.params.id, req.actor.userId]);
        if (!session) throw new HttpError(404, "session_not_found");
        if (session.status !== "active") throw new HttpError(409, "session_ended");
        const item = await one(client, `SELECT * FROM eduos_christie_item_for_session($1)`, [session.id]);
        if (!item) throw new HttpError(409, "no_current_item");
        const itemSeq = item.item_seq;
        const wrongSoFar = (await one(client, `SELECT count(*)::int AS n FROM christie_turns WHERE session_id=$1 AND item_id=$2 AND kind='attempt' AND correct=false`, [session.id, item.item_id])).n;
        const out = { replies: [] };
        const say = async (k, body, extra = {}) => { const t = await addTurn(client, session, { speaker: "christie", kind: k, body, itemId: item.item_id, provider: "rules", ...extra }); out.replies.push(turnView(t)); };
        const hintAt = level => item.hints[level - 1];
        const giveNextHint = async (prefix) => {
          if (session.hint_level < item.hints.length) {
            session.hint_level += 1;
            await client.query(`UPDATE christie_sessions SET hint_level=$2,last_activity_at=now() WHERE id=$1`, [session.id, session.hint_level]);
            await say("hint", `${prefix} ${hintAt(session.hint_level)}`, { hintLevel: session.hint_level });
          } else await say("redirect", MESSAGES.noMoreHints);
        };
        const finishItem = async (score) => {
          out.mastery = await updateMastery(client, session, score, session.hint_level, req.actor);
          const next = await serveNextItem(client, session, itemSeq);
          if (next) out.replies.push(turnView(next)); else await say("feedback", MESSAGES.allDone);
        };
        if (kind === "skip") {
          await addTurn(client, session, { speaker: "student", kind: "attempt", body: "(skipped)", itemId: item.item_id, correct: false });
          await finishItem(0);
        } else if (kind === "attempt") {
          const correct = isCorrect(text, item.answer);
          await addTurn(client, session, { speaker: "student", kind: "attempt", body: text.trim(), itemId: item.item_id, correct, hintLevel: session.hint_level });
          out.correct = correct;
          if (correct) {
            const score = itemScore({ correct, hintLevel: session.hint_level, wrongAttempts: wrongSoFar });
            await say("feedback", pick(score === 1 ? MESSAGES.correct : MESSAGES.correctWithHelp, itemSeq), { correct: true });
            await finishItem(score);
          } else await giveNextHint(MESSAGES.tryAgain);
        } else {
          await addTurn(client, session, { speaker: "student", kind: "question", body: text.trim(), itemId: item.item_id });
          const intent = classifyQuestion(text);
          out.intent = intent;
          if (intent === "needs_adult") {
            await say("redirect", MESSAGES.needsAdult);
            if (!session.needs_adult) {
              await client.query(`UPDATE christie_sessions SET needs_adult=true,reviewed_at=NULL,reviewed_by=NULL WHERE id=$1`, [session.id]);
              const teachers = await rows(client, `SELECT teacher_user_id AS id FROM teacher_student_rosters WHERE student_id=$1`, [session.student_id]);
              await enqueueNotifications(client, { districtId: session.district_id, schoolId: session.school_id, recipients: teachers.map(t => t.id), kind: "christie",
                title: "A learner asked Christie to talk to an adult", body: "Open Christie review to see the conversation.", refType: "christie_session", refId: session.id });
              await audit(client, req, "flag", "christie_session", session.id, "needs_adult");
            }
          } else if (intent === "answer_request") {
            await giveNextHint(MESSAGES.refusal);
          } else {
            const learner = await one(client, `SELECT display_name FROM students WHERE id=$1`, [session.student_id]);
            const me = await one(client, `SELECT display_name,email FROM users WHERE id=$1`, [req.actor.userId]);
            const p = provider();
            // 32.6.0: the linked lesson's text joins the approved material, but only
            // once a school leader has approved it and it is published.
            const lesson = await one(client, `SELECT l.content FROM christie_skills k JOIN lessons l ON l.id=k.lesson_id
                WHERE k.id=$1 AND l.status='published' AND l.approved_at IS NOT NULL`, [item.skill_id]);
            const explanation = lesson ? `${item.explanation}\n${lesson.content}` : item.explanation;
            const fields = { question: text, skillTitle: item.skill_title, explanation, prompt: item.prompt, unlockedHints: item.hints.slice(0, session.hint_level) };
            // Before anything can go to an external provider, every field loses
            // the names and numbers of any student in the district it mentions
            // (another learner in the question, a name in a lesson or hint).
            // If that lookup fails, the request fails: nothing is sent.
            const outbound = p.name === "local" ? null
              : outboundHelpFields(fields, await findStudentIdentifiers(client, session.district_id, helpFieldsText(fields)),
                  [learner?.display_name, me?.display_name, ...(await peopleAround(client, session.student_id))]);
            const reply = await p.help({ ...fields, firstHint: item.hints[0], answer: item.answer, outbound });
            await say("hint", reply.text, { provider: reply.fallback ? "local" : p.name });
          }
        }
        await client.query(`UPDATE christie_sessions SET last_activity_at=now() WHERE id=$1`, [session.id]);
        await audit(client, req, "turn", "christie_session", session.id, `kind=${kind}${out.correct !== undefined ? `;correct=${out.correct}` : ""}`);
        return out;
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/christie/sessions/:id/end", requireSession, requireCsrf, requirePermission("christie", "tutor"), async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_session_id" });
    try {
      const n = await withTenantTransaction(req.actor, async client => {
        const r = await client.query(`UPDATE christie_sessions SET status='ended' WHERE id=$1 AND user_id=$2 AND status='active'`, [req.params.id, req.actor.userId]);
        if (r.rowCount) await audit(client, req, "end", "christie_session", req.params.id);
        return r.rowCount;
      });
      if (!n) return res.status(404).json({ error: "session_not_found" });
      res.json({ data: { ended: true } });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- learner own session / staff review of one session ----
  app.get("/api/christie/sessions/:id", requireSession, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_session_id" });
    if (!["pupil", "teacher", "principal", "superintendent"].includes(req.actor.role)) return res.status(403).json({ error: "forbidden" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const staff = req.actor.role !== "pupil";
        // RLS (migration 012) limits rows to the learner or staff with scope.
        const v = await sessionView(client, req.params.id, { forStaff: staff });
        if (v) await audit(client, req, "read", "christie_session", req.params.id);
        return v;
      });
      if (!data) return res.status(404).json({ error: "session_not_found" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.get("/api/christie/review", requireSession, requirePermission("christie", "review"), async (req, res, next) => {
    const studentId = req.query.studentId;
    if (studentId !== undefined && !validId(studentId)) return res.status(400).json({ error: "invalid_student_id" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const list = await rows(client, `SELECT cs.id,cs.status,cs.needs_adult,cs.reviewed_at,cs.last_activity_at,cs.student_id,st.display_name AS student_name,
              k.title AS skill_title,coalesce(m.mastery,0) AS mastery,
              (SELECT count(*)::int FROM christie_turns t WHERE t.session_id=cs.id AND t.kind='hint') AS hints,
              (SELECT count(*)::int FROM christie_turns t WHERE t.session_id=cs.id AND t.kind='attempt' AND t.correct) AS solved
            FROM christie_sessions cs JOIN students st ON st.id=cs.student_id JOIN christie_skills k ON k.id=cs.skill_id
            LEFT JOIN student_skill_mastery m ON m.student_id=cs.student_id AND m.skill_id=cs.skill_id
           WHERE ($1::uuid IS NULL OR cs.student_id=$1) AND ($2<>'principal' OR cs.school_id=$3)
             AND ($2<>'teacher' OR (cs.school_id=$3 AND EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=cs.student_id AND tr.teacher_user_id=$4)))
           ORDER BY cs.needs_adult AND cs.reviewed_at IS NULL DESC, cs.last_activity_at DESC LIMIT 100`,
          [studentId || null, req.actor.role, req.actor.schoolId, req.actor.userId]);
        await audit(client, req, "read", "christie_review", studentId || null, `sessions=${list.length}`);
        return list;
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/christie/sessions/:id/review", requireSession, requireCsrf, requirePermission("christie", "review"), async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_session_id" });
    try {
      const n = await withTenantTransaction(req.actor, async client => {
        const r = await client.query(`UPDATE christie_sessions SET reviewed_at=now(),reviewed_by=$2 WHERE id=$1
            AND ($3<>'principal' OR school_id=$4)
            AND ($3<>'teacher' OR EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=christie_sessions.student_id AND tr.teacher_user_id=$2))`,
          [req.params.id, req.actor.userId, req.actor.role, req.actor.schoolId]);
        if (r.rowCount) await audit(client, req, "review", "christie_session", req.params.id);
        return r.rowCount;
      });
      if (!n) return res.status(404).json({ error: "session_not_found" });
      res.json({ data: { reviewed: true } });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- teacher copilot: a computed class summary (no generative AI) ----
  app.get("/api/christie/copilot", requireSession, roleIn("teacher"), async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const roster = await rows(client, `SELECT s.id,s.display_name FROM students s JOIN teacher_student_rosters tr ON tr.student_id=s.id AND tr.teacher_user_id=$1 WHERE s.school_id=$2 ORDER BY s.display_name`, [req.actor.userId, req.actor.schoolId]);
        const ids = roster.map(r => r.id);
        const bySkill = await rows(client, `SELECT k.id,k.title,k.subject,count(m.student_id)::int AS learners,round(avg(m.mastery))::int AS avg_mastery,
              count(*) FILTER (WHERE m.mastery>=${MASTERED_AT})::int AS mastered
            FROM student_skill_mastery m JOIN christie_skills k ON k.id=m.skill_id WHERE m.student_id=ANY($1) GROUP BY k.id,k.title,k.subject ORDER BY avg(m.mastery)`, [ids]);
        const flagged = await rows(client, `SELECT cs.id,st.display_name AS student_name,k.title AS skill_title,cs.last_activity_at FROM christie_sessions cs
            JOIN students st ON st.id=cs.student_id JOIN christie_skills k ON k.id=cs.skill_id WHERE cs.student_id=ANY($1) AND cs.needs_adult AND cs.reviewed_at IS NULL`, [ids]);
        const struggling = await rows(client, `SELECT st.display_name AS student_name,k.title AS skill_title,m.mastery,m.attempts FROM student_skill_mastery m
            JOIN students st ON st.id=m.student_id JOIN christie_skills k ON k.id=m.skill_id WHERE m.student_id=ANY($1) AND m.attempts>=3 AND m.mastery<50 ORDER BY m.mastery LIMIT 10`, [ids]);
        const suggestions = [];
        if (flagged.length) suggestions.push(`${flagged.length} learner${flagged.length > 1 ? "s" : ""} asked to talk to an adult. Review ${flagged.length > 1 ? "those sessions" : "that session"} first.`);
        const low = bySkill.find(s => s.learners >= 2 && s.avg_mastery < 60);
        if (low) suggestions.push(`Consider re-teaching "${low.title}": class average ${low.avg_mastery}% across ${low.learners} learners.`);
        if (struggling.length) suggestions.push(`${struggling.length} learner/skill pair${struggling.length > 1 ? "s are" : " is"} below 50% after 3+ problems; a quick check-in may help.`);
        if (!suggestions.length) suggestions.push("No action needed from Christie data today.");
        await audit(client, req, "read", "christie_copilot", null, `roster=${ids.length}`);
        return { rosterSize: ids.length, bySkill, flagged, struggling, suggestions,
          note: "Computed from tutoring records with fixed rules. Not generated by AI, and not a prediction about any learner." };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // ---- content: staff list, author drafts, principal approves ----
  app.get("/api/christie/skills", requireSession, requirePermission("christie", "author"), async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const skills = await rows(client, `SELECT k.id,k.subject,k.grade_level,k.code,k.title,k.sequence,k.explanation,k.source,k.status,k.school_id,
              k.created_by,cu.display_name AS created_by_name,k.approved_at,au.display_name AS approved_by_name
            FROM christie_skills k LEFT JOIN users cu ON cu.id=k.created_by LEFT JOIN users au ON au.id=k.approved_by
           WHERE k.status<>'retired' ORDER BY k.grade_level,k.subject,k.sequence`);
        const items = await rows(client, `SELECT skill_id,seq,prompt,answer,hints FROM christie_items WHERE skill_id=ANY($1) ORDER BY skill_id,seq`, [skills.map(s => s.id)]);
        for (const s of skills) s.items = items.filter(i => i.skill_id === s.id).map(({ skill_id: _x, ...i }) => i);
        return skills;
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/christie/skills", requireSession, requireCsrf, requirePermission("christie", "author"), async (req, res, next) => {
    const { subject, gradeLevel, code, title, sequence = 1, explanation, source = null, items } = req.body || {};
    if (!cleanText(subject, 40) || !cleanText(gradeLevel, 4) || !/^[A-Za-z0-9._-]{1,40}$/.test(code || "") || !cleanText(title, 120) ||
        !Number.isInteger(sequence) || sequence < 1 || sequence > 1000 || !cleanText(explanation, 4000) || (source !== null && !cleanText(source, 300)) ||
        !Array.isArray(items) || items.length < 1 || items.length > 50 ||
        !items.every(i => cleanText(i?.prompt, 500) && cleanText(i?.answer, 120) && Array.isArray(i.hints) && i.hints.length >= 1 && i.hints.length <= 6 && i.hints.every(h => cleanText(h, 500))))
      return res.status(400).json({ error: "invalid_skill" });
    if (!req.actor.schoolId && req.actor.role !== "superintendent") return res.status(400).json({ error: "school_required" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const k = await one(client, `INSERT INTO christie_skills(district_id,school_id,subject,grade_level,code,title,sequence,explanation,source,created_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,status`,
          [req.actor.districtId, req.actor.schoolId || null, subject.trim(), gradeLevel.trim(), code, title.trim(), sequence, explanation.trim(), source, req.actor.userId]);
        let seq = 1;
        for (const i of items)
          await client.query(`INSERT INTO christie_items(district_id,skill_id,seq,prompt,answer,hints) VALUES($1,$2,$3,$4,$5,$6)`,
            [req.actor.districtId, k.id, seq++, i.prompt.trim(), i.answer.trim(), i.hints.map(h => h.trim())]);
        await audit(client, req, "create", "christie_skill", k.id, `items=${items.length}`);
        return k;
      });
      res.status(201).json({ data: out });
    } catch (e) {
      if (e?.code === "23505") return res.status(409).json({ error: "skill_code_taken" });
      sendError(res, next, e);
    }
  });

  app.post("/api/christie/skills/:id/approve", requireSession, requireCsrf, requirePermission("christie", "approve"), async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_skill_id" });
    try {
      const n = await withTenantTransaction(req.actor, async client => {
        const r = await client.query(`UPDATE christie_skills SET status='approved',approved_by=$2,approved_at=now() WHERE id=$1 AND status='draft'
            AND ($3='superintendent' OR school_id=$4)`, [req.params.id, req.actor.userId, req.actor.role, req.actor.schoolId]);
        if (r.rowCount) await audit(client, req, "approve", "christie_skill", req.params.id);
        return r.rowCount;
      });
      if (!n) return res.status(404).json({ error: "draft_not_found" });
      res.json({ data: { approved: true } });
    } catch (e) { sendError(res, next, e); }
  });
}
