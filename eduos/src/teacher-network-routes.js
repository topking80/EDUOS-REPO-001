// TEACH-01: the district teacher network (db/101).
//
// Teachers and principals at every school in the district find each other,
// message one another (one-to-one or a few colleagues), and keep open groups
// that any colleague can find and join. Reading and replying use the Comms Hub
// routes (comms-routes.js), which also handle reports and moderation.
//
// Rules (RLS repeats them): only educators (teacher, principal; the
// superintendent reads and moderates); no learner is ever attached to a
// network thread; families and pupils can't be added. Every write is audited.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { enqueueNotifications } from "./notify.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";

export const NETWORK_ROLES = ["teacher", "principal"];
const READERS = [...NETWORK_ROLES, "superintendent"];

const onlyNetwork = (req, res, next) => READERS.includes(req.actor?.role) ? next() : res.status(403).json({ error: "teacher_network_only" });
const onlyMembers = (req, res, next) => NETWORK_ROLES.includes(req.actor?.role) ? next() : res.status(403).json({ error: "teacher_network_members_only" });

/** Active teachers and principals in the district, with their schools. */
async function colleagues(client, a, { q = "", schoolId = null, ids = null, limit = 200 } = {}) {
  return rows(client, `SELECT u.id AS user_id,u.display_name AS name,
        array_agg(DISTINCT m.role ORDER BY m.role) AS roles,
        json_agg(DISTINCT jsonb_build_object('id',s.id,'name',s.name)) AS schools
      FROM memberships m JOIN users u ON u.id=m.user_id AND u.status='active' JOIN schools s ON s.id=m.school_id
     WHERE m.district_id=$1 AND m.status='active' AND m.role=ANY($2) AND u.id<>$3
       AND ($4='' OR u.display_name ILIKE '%'||$4||'%' OR s.name ILIKE '%'||$4||'%')
       AND ($5::uuid IS NULL OR m.school_id=$5) AND ($6::uuid[] IS NULL OR u.id=ANY($6))
     GROUP BY u.id,u.display_name ORDER BY u.display_name LIMIT $7`,
    [a.districtId, NETWORK_ROLES, a.userId, q.replace(/[%_\\]/g, "\\$&"), schoolId, ids, limit]);
}

async function addPeople(client, a, threadId, ids) {
  const found = await colleagues(client, a, { ids, limit: ids.length });
  if (found.length !== ids.length) throw new HttpError(403, "participant_not_in_network");
  for (const c of found)
    await client.query(`INSERT INTO comms_participants(thread_id,district_id,user_id,role,added_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(thread_id,user_id) DO UPDATE SET left_at=NULL`,
      [threadId, a.districtId, c.user_id, c.roles.includes("teacher") ? "teacher" : "principal", a.userId]);
  return found;
}

async function notify(client, a, thread, recipients, title) {
  if (recipients.length) await enqueueNotifications(client, { districtId: a.districtId, schoolId: thread.school_id, recipients, kind: "message",
    title, body: null, refType: "comms_thread", refId: thread.id });
}

const ids = v => Array.isArray(v) && v.length >= 1 && v.length <= 20 && v.every(validId) ? [...new Set(v)] : null;

export function registerTeacherNetworkRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: config.commsRateLimit, standardHeaders: true, legacyHeaders: false });
  const read = [requireSession, requirePermission("comms", "read"), onlyNetwork];
  const write = [limiter, requireSession, requireCsrf, requirePermission("comms", "message"), onlyMembers];

  app.get("/api/network/colleagues", ...read, async (req, res, next) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
    const schoolId = validId(req.query.schoolId) ? req.query.schoolId : null;
    try {
      const data = await withTenantTransaction(req.actor, async client => ({
        colleagues: await colleagues(client, req.actor, { q, schoolId }),
        schools: await rows(client, `SELECT id,name FROM schools WHERE district_id=$1 AND status='active' ORDER BY name`, [req.actor.districtId])
      }));
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.get("/api/network/groups", ...read, async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, client => rows(client, `SELECT t.id,t.subject AS name,t.description,t.last_message_at,t.status,
            s.name AS started_at_school,u.display_name AS started_by,
            (SELECT count(*)::int FROM comms_participants p WHERE p.thread_id=t.id AND p.left_at IS NULL) AS members,
            EXISTS(SELECT 1 FROM comms_participants p WHERE p.thread_id=t.id AND p.user_id=$1 AND p.left_at IS NULL) AS joined
          FROM comms_threads t JOIN schools s ON s.id=t.school_id JOIN users u ON u.id=t.created_by
         WHERE t.kind='network' AND t.discoverable ORDER BY t.last_message_at DESC LIMIT 200`, [req.actor.userId]));
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // A conversation with one or a few colleagues (not listed to others).
  app.post("/api/network/threads", ...write, async (req, res, next) => {
    const { subject, body } = req.body || {};
    const people = ids(req.body?.participantIds);
    if (!people || people.includes(req.actor.userId) || !cleanText(subject, 160) || !cleanText(body, 4000)) return res.status(400).json({ error: "invalid_thread" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const a = req.actor;
        const t = await one(client, `INSERT INTO comms_threads(district_id,school_id,kind,subject,created_by) VALUES($1,$2,'network',$3,$4) RETURNING id,school_id`,
          [a.districtId, a.schoolId, subject.trim(), a.userId]);
        await client.query(`INSERT INTO comms_participants(thread_id,district_id,user_id,role,added_by) VALUES($1,$2,$3,$4,$3)`, [t.id, a.districtId, a.userId, a.role]);
        const found = await addPeople(client, a, t.id, people);
        await client.query(`INSERT INTO comms_messages(district_id,school_id,thread_id,author_user_id,body) VALUES($1,$2,$3,$4,$5)`, [a.districtId, t.school_id, t.id, a.userId, body.trim()]);
        await notify(client, a, t, found.map(c => c.user_id), `New message from a colleague: ${subject.trim().slice(0, 100)}`);
        await audit(client, req, "create", "comms_thread", t.id, `kind=network;participants=${found.length + 1}`);
        return { id: t.id };
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  // An open group colleagues can find and join.
  app.post("/api/network/groups", ...write, async (req, res, next) => {
    const { name, description = null, body = null } = req.body || {};
    if (!cleanText(name, 160) || (description !== null && !cleanText(description, 300)) || (body !== null && !cleanText(body, 4000)))
      return res.status(400).json({ error: "invalid_group" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const a = req.actor;
        const t = await one(client, `INSERT INTO comms_threads(district_id,school_id,kind,subject,description,discoverable,created_by)
            VALUES($1,$2,'network',$3,$4,true,$5) RETURNING id,school_id`, [a.districtId, a.schoolId, name.trim(), description?.trim() || null, a.userId]);
        await client.query(`INSERT INTO comms_participants(thread_id,district_id,user_id,role,added_by) VALUES($1,$2,$3,$4,$3)`, [t.id, a.districtId, a.userId, a.role]);
        if (body) await client.query(`INSERT INTO comms_messages(district_id,school_id,thread_id,author_user_id,body) VALUES($1,$2,$3,$4,$5)`, [a.districtId, t.school_id, t.id, a.userId, body.trim()]);
        await audit(client, req, "create", "network_group", t.id, null);
        return { id: t.id };
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/network/groups/:id/join", ...write, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    try {
      await withTenantTransaction(req.actor, async client => {
        const t = await one(client, `SELECT id,status FROM comms_threads WHERE id=$1 AND kind='network' AND discoverable`, [req.params.id]);
        if (!t) throw new HttpError(404, "group_not_found");
        if (t.status !== "open") throw new HttpError(409, "thread_locked");
        await client.query(`INSERT INTO comms_participants(thread_id,district_id,user_id,role,added_by) VALUES($1,$2,$3,$4,$3)
            ON CONFLICT(thread_id,user_id) DO UPDATE SET left_at=NULL`, [t.id, req.actor.districtId, req.actor.userId, req.actor.role]);
        await audit(client, req, "join", "network_group", t.id, null);
      });
      res.json({ data: { joined: true } });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/network/threads/:id/leave", ...write, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    try {
      const n = await withTenantTransaction(req.actor, async client => {
        const r = await client.query(`UPDATE comms_participants p SET left_at=now() FROM comms_threads t
            WHERE p.thread_id=$1 AND p.user_id=$2 AND p.left_at IS NULL AND t.id=p.thread_id AND t.kind='network'`, [req.params.id, req.actor.userId]);
        if (r.rowCount) await audit(client, req, "leave", "comms_thread", req.params.id, null);
        return r.rowCount;
      });
      if (!n) return res.status(404).json({ error: "not_a_member" });
      res.json({ data: { left: true } });
    } catch (e) { sendError(res, next, e); }
  });

  // Any member of a network thread can bring colleagues in.
  app.post("/api/network/threads/:id/participants", ...write, async (req, res, next) => {
    const people = ids(req.body?.userIds);
    if (!validId(req.params.id) || !people) return res.status(400).json({ error: "invalid_participants" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const t = await one(client, `SELECT t.id,t.school_id,t.subject,t.status FROM comms_threads t
            JOIN comms_participants me ON me.thread_id=t.id AND me.user_id=$2 AND me.left_at IS NULL WHERE t.id=$1 AND t.kind='network'`, [req.params.id, req.actor.userId]);
        if (!t) throw new HttpError(404, "thread_not_found");
        if (t.status !== "open") throw new HttpError(409, "thread_locked");
        const found = await addPeople(client, req.actor, t.id, people.filter(id => id !== req.actor.userId));
        await notify(client, req.actor, t, found.map(c => c.user_id), `You were added to: ${t.subject.slice(0, 120)}`);
        await audit(client, req, "add_participants", "comms_thread", t.id, `added=${found.length}`);
        return { added: found.length };
      });
      res.json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });
}
