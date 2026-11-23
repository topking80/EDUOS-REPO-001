// TEACH-05: the portable teacher profile (db/113, src/portfolio-package.js).
//
// Rights (copyright / patent) claims:
//   GET  /api/portfolio/claims?status=          the teacher's own; reviewers: their school / district
//   POST /api/portfolio/claims                  {itemKind, itemId, claimType, registration?, evidenceUrl?, statement}
//   POST /api/portfolio/claims/:id/withdraw
//   POST /api/portfolio/claims/:id/decision     principal (teacher's school) / superintendent: {decision, note}
// Packages (the teacher's, across districts):
//   GET  /api/portfolio/preview                 what a package from here would hold, and what's left out
//   POST /api/portfolio/packages                make one
//   GET  /api/portfolio/packages
//   POST /api/portfolio/packages/:id/withdraw
// Bringing a package into a new district:
//   POST /api/portfolio/imports {packageId}
//   GET  /api/portfolio/imports                 the teacher's; reviewers: waiting in their school / district
//   POST /api/portfolio/imports/:id/review      {decisions:[{index, decision}], note}
//   POST /api/portfolio/imports/:id/licenses    the teacher adds the package's licenses here (self-reported)
// The teacher's library here:
//   GET  /api/portfolio/library
//   POST /api/portfolio/library/:id/copy        lesson → {courseId, unitId}; unit → {courseId}; coaching plan → {}
//   POST /api/portfolio/library/:id/archive
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { studentWordsIn } from "./materials-routes.js";
import { FORMAT, seal, check, itemText, signingKeys } from "./portfolio-package.js";

const TEACHERS = ["teacher"];
const REVIEWERS = ["principal", "superintendent"];
const KINDS = ["unit", "lesson", "coaching_plan"];
const https = u => { try { const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password && u.length <= 500; } catch { return false; } };
const ymd = d => d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
const claimOut = c => ({ id: c.id, owner: c.owner, ownerId: c.owner_user_id, itemKind: c.item_kind, itemId: c.item_id, title: c.title, claimType: c.claim_type,
  registration: c.registration, evidenceUrl: c.evidence_url, statement: c.statement, status: c.status, reviewedBy: c.reviewer, reviewedAt: c.reviewed_at, note: c.review_note, createdAt: c.created_at });

/** The teacher's own work in this district, as package items (no student information). */
async function myWork(c, a) {
  const district = (await one(c, `SELECT name FROM districts WHERE id=$1`, [a.districtId]))?.name || "Previous district";
  const approval = l => l.approved_at ? { by: l.approver, at: ymd(l.approved_at), district } : null;
  const lessons = await rows(c, `SELECT l.id,l.unit_id,l.course_id,l.seq,l.title,l.objective,l.content,l.status,l.approved_at,u.display_name AS approver
      FROM lessons l LEFT JOIN users u ON u.id=l.approved_by WHERE l.created_by=$1 ORDER BY l.course_id,l.unit_id,l.seq`, [a.userId]);
  const units = await rows(c, `SELECT cu.id,cu.title,cu.summary,co.title AS course FROM course_units cu JOIN courses co ON co.id=cu.course_id
      WHERE co.teacher_user_id=$1 ORDER BY co.title,cu.seq`, [a.userId]);
  const plans = await rows(c, `SELECT id,kind,title,sport,level,body FROM coaching_plans WHERE owner_user_id=$1 AND archived_at IS NULL ORDER BY title`, [a.userId]);
  const lessonBody = l => ({ title: l.title, objective: l.objective, content: l.content });
  const items = [];
  for (const u of units) {
    const ls = lessons.filter(l => l.unit_id === u.id);
    if (!ls.length) continue;
    items.push({ kind: "unit", id: u.id, title: u.title, body: { course: u.course, summary: u.summary, lessons: ls.map(lessonBody) },
      approval: ls.every(l => l.approved_at) ? approval(ls[0]) : null });
  }
  const inUnits = new Set(units.map(u => u.id));
  for (const l of lessons.filter(l => !inUnits.has(l.unit_id))) items.push({ kind: "lesson", id: l.id, title: l.title, body: { objective: l.objective, content: l.content }, approval: approval(l) });
  for (const p of plans) items.push({ kind: "coaching_plan", id: p.id, title: p.title, body: { kind: p.kind, sport: p.sport, level: p.level, ...p.body }, approval: null });
  return { district, items };
}

async function buildManifest(c, a) {
  const { district, items } = await myWork(c, a);
  const claims = await rows(c, `SELECT item_kind,item_id,claim_type,registration,evidence_url FROM teacher_work_claims WHERE owner_user_id=$1 AND status='approved'`, [a.userId]);
  const me = await one(c, `SELECT display_name FROM users WHERE id=$1`, [a.userId]);
  const licenses = (await rows(c, `SELECT state_code,license_number,license_type,endorsements,issued_on,expires_on,status FROM educator_licenses WHERE user_id=$1 AND retired_at IS NULL`, [a.userId]))
    .map(l => ({ stateCode: l.state_code, number: l.license_number, type: l.license_type, endorsements: l.endorsements, issuedOn: ymd(l.issued_on), expiresOn: ymd(l.expires_on),
      verifiedBy: l.status === "verified" ? district : null }));
  const kept = [], excluded = [];
  for (const it of items) {
    const words = await studentWordsIn(c, a.districtId, itemText(it));
    if (words.length) { excluded.push({ kind: it.kind, title: it.title, reason: "may_mention_students" }); continue; }
    const r = claims.find(x => x.item_kind === it.kind && x.item_id === it.id);
    kept.push({ kind: it.kind, origin: it.id, title: it.title, body: it.body, approval: it.approval,
      rights: r ? { type: r.claim_type, registration: r.registration, evidenceUrl: r.evidence_url, approvedBy: district } : null, schoolKeepsCopy: !r });
  }
  return { format: FORMAT, owner: { name: me?.display_name || "" }, issuedBy: { district }, issuedAt: new Date().toISOString(), items: kept, licenses, excluded };
}

export function registerPortfolioRoutes(app) {
  signingKeys(); // a PORTFOLIO_SIGNING_SECRET that's set but too short stops the server at start, not at the first package
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const only = roles => (req, res, next) => roles.includes(req.actor?.role) ? next() : res.status(403).json({ error: "forbidden" });
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: out }); }
    catch (e) { if (e.code === "23505") return res.status(409).json({ error: "already_exists" }); sendError(res, next, e); }
  };

  // ---------- rights claims ----------
  app.get("/api/portfolio/claims", requireSession, only([...TEACHERS, ...REVIEWERS]), run(async (c, req) => {
    const status = ["pending", "approved", "rejected", "withdrawn"].includes(req.query.status) ? req.query.status : null;
    return (await rows(c, `SELECT k.*,o.display_name AS owner,r.display_name AS reviewer FROM teacher_work_claims k JOIN users o ON o.id=k.owner_user_id LEFT JOIN users r ON r.id=k.reviewed_by
        WHERE ($1::text IS NULL OR k.status=$1) ORDER BY (k.status='pending') DESC,k.created_at DESC LIMIT 500`, [status])).map(claimOut);
  }));

  app.post("/api/portfolio/claims", limiter, requireSession, requireCsrf, only(TEACHERS), run(async (c, req) => {
    const b = req.body || {};
    const reg = typeof b.registration === "string" && b.registration.trim() ? b.registration.trim() : null, url = b.evidenceUrl || null;
    if (!KINDS.includes(b.itemKind) || !validId(b.itemId) || !["copyright", "patent"].includes(b.claimType) || !cleanText(b.statement, 1000, 10)
        || (reg && reg.length > 80) || (url && !https(url))) throw new HttpError(400, "invalid_claim");
    if (!reg && !url) throw new HttpError(400, "evidence_required");
    const item = b.itemKind === "lesson" ? await one(c, `SELECT title FROM lessons WHERE id=$1 AND created_by=$2`, [b.itemId, req.actor.userId])
      : b.itemKind === "unit" ? await one(c, `SELECT cu.title FROM course_units cu JOIN courses co ON co.id=cu.course_id WHERE cu.id=$1 AND co.teacher_user_id=$2`, [b.itemId, req.actor.userId])
      : await one(c, `SELECT title FROM coaching_plans WHERE id=$1 AND owner_user_id=$2`, [b.itemId, req.actor.userId]);
    if (!item) throw new HttpError(404, "not_your_work");
    if (!req.actor.schoolId) throw new HttpError(400, "school_required");
    const k = await one(c, `INSERT INTO teacher_work_claims(district_id,school_id,owner_user_id,item_kind,item_id,title,claim_type,registration,evidence_url,statement)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [req.actor.districtId, req.actor.schoolId, req.actor.userId, b.itemKind, b.itemId, item.title, b.claimType, reg, url, b.statement.trim()]);
    await audit(c, req, "create", "work_claim", k.id, `${b.claimType} ${b.itemKind}`);
    return k;
  }, 201));

  app.post("/api/portfolio/claims/:id/withdraw", limiter, requireSession, requireCsrf, only(TEACHERS), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const k = await one(c, `UPDATE teacher_work_claims SET status='withdrawn' WHERE id=$1 AND owner_user_id=$2 AND status='pending' RETURNING id`, [req.params.id, req.actor.userId]);
    if (!k) throw new HttpError(404, "claim_not_found");
    await audit(c, req, "withdraw", "work_claim", k.id, null);
    return { withdrawn: true };
  }));

  app.post("/api/portfolio/claims/:id/decision", limiter, requireSession, requireCsrf, only(REVIEWERS), run(async (c, req) => {
    const { decision, note = null } = req.body || {};
    if (!validId(req.params.id) || !["approved", "rejected"].includes(decision) || (note != null && note !== "" && !cleanText(note, 500))) throw new HttpError(400, "invalid_decision");
    if (decision === "rejected" && !cleanText(note, 500)) throw new HttpError(400, "reason_required");
    const k = await one(c, `UPDATE teacher_work_claims SET status=$2,reviewed_by=$3,reviewed_at=now(),review_note=$4 WHERE id=$1 AND status='pending' RETURNING id`,
      [req.params.id, decision, req.actor.userId, note?.trim() || null]);
    if (!k) throw new HttpError(404, "claim_not_found");
    await audit(c, req, "decide", "work_claim", k.id, decision);
    return { status: decision };
  }));

  // ---------- packages ----------
  app.get("/api/portfolio/preview", requireSession, only(TEACHERS), run(async (c, req) => {
    const m = await buildManifest(c, req.actor);
    return { items: m.items.map(i => ({ id: i.origin, kind: i.kind, title: i.title, approval: i.approval, rights: i.rights, schoolKeepsCopy: i.schoolKeepsCopy })), licenses: m.licenses.length, excluded: m.excluded };
  }));

  app.post("/api/portfolio/packages", limiter, requireSession, requireCsrf, only(TEACHERS), run(async (c, req) => {
    const m = await buildManifest(c, req.actor);
    if (!m.items.length && !m.licenses.length) throw new HttpError(409, "nothing_to_package");
    const s = seal(m);
    const p = await one(c, `INSERT INTO portfolio_packages(owner_user_id,issued_by_district_id,manifest,manifest_sha256,signature,signer_public_key,item_count)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,issued_at`, [req.actor.userId, req.actor.districtId, m, s.sha256, s.signature, s.publicKey, m.items.length]);
    await audit(c, req, "create", "portfolio_package", p.id, `items=${m.items.length} excluded=${m.excluded.length}`);
    return { id: p.id, issuedAt: p.issued_at, items: m.items.length, licenses: m.licenses.length, excluded: m.excluded, sha256: s.sha256, signed: Boolean(s.signature),
      schoolKeeps: m.items.filter(i => i.schoolKeepsCopy).length };
  }, 201));

  app.get("/api/portfolio/packages", requireSession, only(TEACHERS), run(async (c, req) =>
    (await rows(c, `SELECT p.id,p.issued_at,p.item_count,coalesce(p.external_issuer,p.manifest->'issuedBy'->>'district') AS district,p.manifest_sha256,p.signature IS NOT NULL AS signed,p.withdrawn_at,
        coalesce(p.issued_by_district_id=$2,false) AS from_here FROM portfolio_packages p WHERE p.owner_user_id=$1 ORDER BY p.issued_at DESC`, [req.actor.userId, req.actor.districtId]))
      .map(p => ({ id: p.id, issuedAt: p.issued_at, items: p.item_count, district: p.district, sha256: p.manifest_sha256, signed: p.signed, withdrawn: Boolean(p.withdrawn_at), fromHere: p.from_here }))));

  app.post("/api/portfolio/packages/:id/withdraw", limiter, requireSession, requireCsrf, only(TEACHERS), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const p = await one(c, `UPDATE portfolio_packages SET withdrawn_at=now() WHERE id=$1 AND owner_user_id=$2 AND withdrawn_at IS NULL RETURNING id`, [req.params.id, req.actor.userId]);
    if (!p) throw new HttpError(404, "package_not_found");
    await audit(c, req, "withdraw", "portfolio_package", p.id, null);
    return { withdrawn: true };
  }));

  // ---------- bringing a package in ----------
  app.post("/api/portfolio/imports", limiter, requireSession, requireCsrf, only(TEACHERS), run(async (c, req) => {
    const id = req.body?.packageId;
    if (!validId(id)) throw new HttpError(400, "invalid_id");
    const p = await one(c, `SELECT * FROM portfolio_packages WHERE id=$1 AND owner_user_id=$2 AND withdrawn_at IS NULL`, [id, req.actor.userId]);
    if (!p) throw new HttpError(404, "package_not_found");
    if (p.issued_by_district_id === req.actor.districtId) throw new HttpError(409, "package_is_from_this_district");
    const v = check(p.manifest, { sha256: p.manifest_sha256, signature: p.signature, publicKey: p.signer_public_key });
    if (!v.ok) throw new HttpError(422, "package_failed_its_check");
    const items = p.manifest.items.map((it, index) => ({ index, kind: it.kind, title: it.title, body: it.body, approval: it.approval, rights: it.rights }));
    const i = await one(c, `INSERT INTO portfolio_imports(district_id,school_id,owner_user_id,package_id,package_sha256,from_district,signed,items,licenses)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [req.actor.districtId, req.actor.schoolId, req.actor.userId, p.id, p.manifest_sha256,
      p.external_issuer || p.manifest.issuedBy.district, v.signed, JSON.stringify(items), JSON.stringify(p.manifest.licenses || [])]);
    await audit(c, req, "create", "portfolio_import", i.id, `items=${items.length}`);
    return { id: i.id, items: items.length, signed: v.signed };
  }, 201));

  app.get("/api/portfolio/imports", requireSession, only([...TEACHERS, ...REVIEWERS]), run(async (c, req) =>
    (await rows(c, `SELECT i.*,o.display_name AS owner,r.display_name AS reviewer FROM portfolio_imports i JOIN users o ON o.id=i.owner_user_id LEFT JOIN users r ON r.id=i.reviewed_by
       ORDER BY (i.status='pending') DESC,i.created_at DESC LIMIT 200`)).map(i => ({ id: i.id, owner: i.owner, ownerId: i.owner_user_id, fromDistrict: i.from_district, signed: i.signed,
      status: i.status, createdAt: i.created_at, reviewedBy: i.reviewer, reviewedAt: i.reviewed_at, note: i.review_note, licenses: i.licenses,
      items: i.items.map(x => ({ index: x.index, kind: x.kind, title: x.title, body: x.body, approval: x.approval, rights: x.rights, decision: x.decision ?? null })) }))));

  app.post("/api/portfolio/imports/:id/review", limiter, requireSession, requireCsrf, only(REVIEWERS), run(async (c, req) => {
    const { decisions, note = null } = req.body || {};
    if (!validId(req.params.id) || !Array.isArray(decisions) || !decisions.length || (note != null && note !== "" && !cleanText(note, 500))) throw new HttpError(400, "invalid_review");
    const imp = await one(c, `SELECT * FROM portfolio_imports WHERE id=$1 AND status='pending' FOR UPDATE`, [req.params.id]);
    if (!imp || imp.owner_user_id === req.actor.userId) throw new HttpError(404, "import_not_found");
    const items = imp.items;
    for (const d of decisions) if (!Number.isInteger(d?.index) || !items[d.index] || !["approved", "rejected"].includes(d.decision)) throw new HttpError(400, "invalid_review");
    if (decisions.length !== items.length || new Set(decisions.map(d => d.index)).size !== items.length) throw new HttpError(400, "decide_every_item");
    let approved = 0;
    for (const d of decisions) {
      const it = items[d.index]; it.decision = d.decision;
      if (d.decision !== "approved") continue;
      await c.query(`INSERT INTO teacher_library_items(district_id,owner_user_id,import_id,kind,title,body,origin,prior_approval,rights,approved_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [imp.district_id, imp.owner_user_id, imp.id, it.kind, it.title.slice(0, 160), it.body, imp.from_district, it.approval, it.rights, req.actor.userId]);
      approved++;
    }
    await c.query(`UPDATE portfolio_imports SET status='reviewed',reviewed_by=$2,reviewed_at=now(),review_note=$3,items=$4 WHERE id=$1`, [imp.id, req.actor.userId, note?.trim() || null, JSON.stringify(items)]);
    await audit(c, req, "review", "portfolio_import", imp.id, `approved=${approved} of ${items.length}`);
    return { approved, rejected: items.length - approved };
  }));

  app.post("/api/portfolio/imports/:id/licenses", limiter, requireSession, requireCsrf, only(TEACHERS), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const imp = await one(c, `SELECT licenses FROM portfolio_imports WHERE id=$1 AND owner_user_id=$2`, [req.params.id, req.actor.userId]);
    if (!imp) throw new HttpError(404, "import_not_found");
    let added = 0;
    for (const l of imp.licenses) {
      const exists = await one(c, `SELECT 1 FROM educator_licenses WHERE user_id=$1 AND state_code=$2 AND license_number=$3 AND retired_at IS NULL`, [req.actor.userId, l.stateCode, l.number]);
      if (exists) continue;
      // Added here as self-reported: this district verifies them itself.
      await c.query(`INSERT INTO educator_licenses(district_id,user_id,state_code,license_number,license_type,endorsements,issued_on,expires_on) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [req.actor.districtId, req.actor.userId, l.stateCode, l.number, l.type, l.endorsements, l.issuedOn, l.expiresOn]);
      added++;
    }
    await audit(c, req, "create", "educator_license", null, `from import: ${added}`);
    return { added };
  }, 201));

  // ---------- the teacher's library here ----------
  app.get("/api/portfolio/library", requireSession, only(TEACHERS), run(async (c, req) =>
    (await rows(c, `SELECT t.*,u.display_name AS approver FROM teacher_library_items t JOIN users u ON u.id=t.approved_by WHERE t.owner_user_id=$1 AND t.archived_at IS NULL ORDER BY t.kind,t.title`, [req.actor.userId]))
      .map(t => ({ id: t.id, kind: t.kind, title: t.title, body: t.body, origin: t.origin, priorApproval: t.prior_approval, rights: t.rights, approvedBy: t.approver, approvedAt: t.approved_at }))));

  app.post("/api/portfolio/library/:id/copy", limiter, requireSession, requireCsrf, only(TEACHERS), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const t = await one(c, `SELECT * FROM teacher_library_items WHERE id=$1 AND owner_user_id=$2 AND archived_at IS NULL`, [req.params.id, req.actor.userId]);
    if (!t) throw new HttpError(404, "item_not_found");
    const { courseId, unitId } = req.body || {};
    if (t.kind === "coaching_plan") {
      const b = t.body, { kind, sport, level, ...body } = b;
      const p = await one(c, `INSERT INTO coaching_plans(district_id,owner_user_id,kind,title,sport,level,body) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [req.actor.districtId, req.actor.userId, kind, t.title.slice(0, 120), sport, level || "All", body]);
      await audit(c, req, "copy", "library_item", t.id, `coaching_plan=${p.id}`);
      return { coachingPlanId: p.id };
    }
    if (!validId(courseId)) throw new HttpError(400, "course_required");
    const course = await one(c, `SELECT id FROM courses WHERE id=$1 AND teacher_user_id=$2 AND status<>'archived'`, [courseId, req.actor.userId]);
    if (!course) throw new HttpError(404, "course_not_found");
    const addLesson = async (unit, l) => {
      const seq = (await one(c, `SELECT coalesce(max(seq),0)+1 AS n FROM lessons WHERE unit_id=$1`, [unit])).n;
      if (seq > 200) throw new HttpError(409, "unit_full");
      return (await one(c, `INSERT INTO lessons(district_id,course_id,unit_id,seq,title,objective,content,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8) RETURNING id`,
        [req.actor.districtId, course.id, unit, seq, String(l.title).slice(0, 120), l.objective, l.content, req.actor.userId])).id;
    };
    if (t.kind === "lesson") {
      if (!validId(unitId) || !(await one(c, `SELECT 1 FROM course_units WHERE id=$1 AND course_id=$2`, [unitId, course.id]))) throw new HttpError(400, "unit_required");
      const id = await addLesson(unitId, { title: t.title, ...t.body });
      await audit(c, req, "copy", "library_item", t.id, `lesson=${id}`);
      return { lessonId: id };
    }
    const seq = (await one(c, `SELECT coalesce(max(seq),0)+1 AS n FROM course_units WHERE course_id=$1`, [course.id])).n;
    if (seq > 200) throw new HttpError(409, "course_full");
    const u = await one(c, `INSERT INTO course_units(district_id,course_id,seq,title,summary) VALUES($1,$2,$3,$4,$5) RETURNING id`, [req.actor.districtId, course.id, seq, t.title.slice(0, 120), t.body.summary || null]);
    for (const l of t.body.lessons || []) await addLesson(u.id, l);
    await audit(c, req, "copy", "library_item", t.id, `unit=${u.id}`);
    return { unitId: u.id, lessons: (t.body.lessons || []).length };
  }, 201));

  app.post("/api/portfolio/library/:id/archive", limiter, requireSession, requireCsrf, only(TEACHERS), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const t = await one(c, `UPDATE teacher_library_items SET archived_at=now() WHERE id=$1 AND owner_user_id=$2 AND archived_at IS NULL RETURNING id`, [req.params.id, req.actor.userId]);
    if (!t) throw new HttpError(404, "item_not_found");
    return { archived: true };
  }));
}
