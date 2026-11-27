// LRH-01: the district's digital learning-resource catalog (db/171). Metadata
// only; files come with provisioning (LRH-03).
//
// District catalog managers (superintendent, district IT):
//   GET   /api/resources/catalog                         every resource and collection, with what's missing to publish
//   POST  /api/resources {title, resourceType, sourceName, sourceUrl, licenseName, licenseUrl?, language?, gradeMin, gradeMax,
//                         subjects?, standards?, audience?, version, sha256?, sizeBytes?, description?}
//   PATCH /api/resources/:id                             a draft's details
//   POST  /api/resources/:id/license-review {decision: approved|rejected, note}   not by whoever added it
//   POST  /api/resources/:id/publish                     superintendent; needs an approved licence and a checksum
//   POST  /api/resources/:id/retire {reason}
//   POST  /api/resource-collections {name, description?, reviewBy?}; PATCH /api/resource-collections/:id
//   POST  /api/resource-collections/:id/items {resourceId}; DELETE /api/resource-collections/:id/items/:resourceId (drafts)
//   POST  /api/resource-collections/:id/publish          superintendent; every item published
//   POST  /api/resource-collections/:id/retire
// School leads (principal or acting vice principal, librarian), for their school:
//   GET   /api/resource-collections/available            published collections, and whether the school uses each
//   POST  /api/resource-collections/:id/select | /unselect
// Everyone, within their school and audience:
//   GET   /api/resources?q&subject&grade&type            published resources in the school's chosen collections
//   GET   /api/resources/:id
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";

const TYPES = ["reference", "pdf", "ebook", "offline_archive", "audio", "video", "image", "map_package", "course_package"];
const AUDIENCES = ["everyone", "staff", "emergency_staff"];
const GRADES = ["pre_k", "k", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
const MANAGERS = ["superintendent", "it_admin"], LEADS = ["principal", "librarian"];
const https = v => { try { const u = new URL(v); return u.protocol === "https:" && v.length <= 500 && !/[\s<>"]/.test(v); } catch { return false; } };
const textList = (v, max, each) => Array.isArray(v) && v.length <= max && v.every(x => cleanText(x, each));
const ymd = v => v instanceof Date ? v.toISOString().slice(0, 10) : v;

const resourceOut = (r, manager) => ({
  id: r.id, title: r.title, description: r.description, type: r.resource_type, source: { name: r.source_name, url: r.source_url },
  license: { name: r.license_name, url: r.license_url, ...(manager ? { status: r.license_status, reviewedAt: r.license_reviewed_at, note: r.license_note } : {}) },
  language: r.language, grades: [r.grade_min, r.grade_max], subjects: r.subjects, standards: r.standards, audience: r.audience, version: r.version,
  sha256: r.sha256, sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes), status: r.status,
  ...(manager ? { createdAt: r.created_at, publishedAt: r.published_at, retiredAt: r.retired_at, retireReason: r.retire_reason, yours: r.yours,
    missing: r.status === "draft" ? [r.license_status !== "approved" && "licence approval", !r.sha256 && "checksum"].filter(Boolean) : [] } : {}),
});

function validate(b, partial) {
  const has = k => b[k] !== undefined;
  const bad = [];
  if ((!partial || has("title")) && !cleanText(b.title, 200, 2)) bad.push("title");
  if ((!partial || has("resourceType")) && !TYPES.includes(b.resourceType)) bad.push("resourceType");
  if ((!partial || has("sourceName")) && !cleanText(b.sourceName, 200, 2)) bad.push("sourceName");
  if ((!partial || has("sourceUrl")) && !https(b.sourceUrl)) bad.push("sourceUrl (https)");
  if ((!partial || has("licenseName")) && !cleanText(b.licenseName, 120, 2)) bad.push("licenseName");
  if (has("licenseUrl") && b.licenseUrl !== null && !https(b.licenseUrl)) bad.push("licenseUrl (https)");
  if (has("language") && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(b.language ?? "")) bad.push("language");
  if ((!partial || has("gradeMin")) && !GRADES.includes(b.gradeMin)) bad.push("gradeMin");
  if ((!partial || has("gradeMax")) && !GRADES.includes(b.gradeMax)) bad.push("gradeMax");
  if (GRADES.includes(b.gradeMin) && GRADES.includes(b.gradeMax) && GRADES.indexOf(b.gradeMin) > GRADES.indexOf(b.gradeMax)) bad.push("gradeMin after gradeMax");
  if (has("subjects") && !textList(b.subjects, 10, 80)) bad.push("subjects");
  if (has("standards") && !textList(b.standards, 30, 60)) bad.push("standards");
  if (has("audience") && !AUDIENCES.includes(b.audience)) bad.push("audience");
  if ((!partial || has("version")) && !cleanText(b.version, 60)) bad.push("version");
  if (has("sha256") && b.sha256 !== null && !/^[0-9a-f]{64}$/.test(b.sha256 ?? "")) bad.push("sha256 (64 hex)");
  if (has("sizeBytes") && b.sizeBytes !== null && !(Number.isSafeInteger(b.sizeBytes) && b.sizeBytes > 0)) bad.push("sizeBytes");
  if (has("description") && b.description !== null && (typeof b.description !== "string" || b.description.length > 2000)) bad.push("description");
  if (bad.length) throw new HttpError(400, "invalid_resource", { fields: bad });
}
const COLUMNS = { title: "title", description: "description", resourceType: "resource_type", sourceName: "source_name", sourceUrl: "source_url", licenseName: "license_name",
  licenseUrl: "license_url", language: "language", gradeMin: "grade_min", gradeMax: "grade_max", subjects: "subjects", standards: "standards", audience: "audience",
  version: "version", sha256: "sha256", sizeBytes: "size_bytes" };
// Licence-relevant details: changing them sends the licence back for review.
const LICENSE_FIELDS = ["sourceUrl", "licenseName", "licenseUrl", "sha256", "version"];

export function registerLearningResourceRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `lr:${req.actor?.userId}` });
  const run = (fn, code = 200) => async (req, res, next) => {
    try {
      if (req.actor?.tenantKind && req.actor.tenantKind !== "district") throw new HttpError(403, "district_context_required");
      const data = await withTenantTransaction(req.actor, c => fn(c, req));
      res.setHeader("Cache-Control", "no-store"); res.status(code).json({ data });
    } catch (e) { if (e.code === "42501") return sendError(res, next, new HttpError(403, "not_allowed")); sendError(res, next, e); }
  };
  const manager = req => { if (!MANAGERS.includes(req.actor.role)) throw new HttpError(403, "catalog_managers_only"); };
  const superintendent = req => { if (req.actor.role !== "superintendent") throw new HttpError(403, "superintendent_only"); };
  const lead = req => { if (!LEADS.includes(req.actor.role) || !req.actor.schoolId) throw new HttpError(403, "school_leads_only"); };
  const resourceOf = async (c, id) => {
    if (!validId(id)) throw new HttpError(400, "invalid_id");
    const r = await one(c, "SELECT *, created_by = eduos_ctx_user() AS yours FROM learning_resources WHERE id=$1", [id]);
    if (!r) throw new HttpError(404, "resource_not_found");
    return r;
  };
  const collectionOf = async (c, id) => {
    if (!validId(id)) throw new HttpError(400, "invalid_id");
    const k = await one(c, "SELECT * FROM learning_resource_collections WHERE id=$1", [id]);
    if (!k) throw new HttpError(404, "collection_not_found");
    return k;
  };

  // ---------- catalog management ----------
  app.get("/api/resources/catalog", requireSession, run(async (c, req) => {
    manager(req);
    const resources = (await rows(c, "SELECT *, created_by = eduos_ctx_user() AS yours FROM learning_resources ORDER BY status='retired', title")).map(r => resourceOut(r, true));
    const collections = await rows(c, `SELECT k.*, (SELECT coalesce(array_agg(i.resource_id ORDER BY i.position), '{}') FROM learning_resource_collection_items i WHERE i.collection_id=k.id) AS items,
        (SELECT count(*)::int FROM learning_resource_school_selections s WHERE s.collection_id=k.id AND s.removed_at IS NULL) AS schools
      FROM learning_resource_collections k ORDER BY k.status='retired', k.name`);
    return { resources, collections: collections.map(k => ({ id: k.id, name: k.name, description: k.description, reviewBy: ymd(k.review_by), status: k.status, items: k.items, schools: k.schools })),
      notice: "Metadata only for now: files are provisioned to schools in a later step. Nothing is published without an approved licence and a checksum." };
  }));
  app.post("/api/resources", limiter, requireSession, requireCsrf, run(async (c, req) => {
    manager(req);
    const b = req.body || {};
    validate(b, false);
    const cols = Object.keys(COLUMNS).filter(k => b[k] !== undefined);
    const r = await one(c, `INSERT INTO learning_resources(district_id, created_by, ${cols.map(k => COLUMNS[k]).join(", ")})
        VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(", ")}) RETURNING *, true AS yours`,
      [req.actor.districtId, req.actor.userId, ...cols.map(k => typeof b[k] === "string" ? b[k].trim() : b[k])]);
    await audit(c, req, "create", "learning_resource", r.id, `${b.resourceType};${b.licenseName}`);
    return resourceOut(r, true);
  }, 201));
  app.patch("/api/resources/:id", limiter, requireSession, requireCsrf, run(async (c, req) => {
    manager(req);
    const r0 = await resourceOf(c, req.params.id), b = req.body || {};
    if (r0.status !== "draft") throw new HttpError(409, "only_drafts_change", { hint: "Retire it and add a new version." });
    validate({ gradeMin: r0.grade_min, gradeMax: r0.grade_max, ...b }, true);
    const cols = Object.keys(COLUMNS).filter(k => b[k] !== undefined);
    if (!cols.length) throw new HttpError(400, "nothing_to_change");
    const reReview = cols.some(k => LICENSE_FIELDS.includes(k)) && r0.license_status !== "unreviewed";
    const sets = cols.map((k, i) => `${COLUMNS[k]}=$${i + 2}`).concat(reReview ? ["license_status='unreviewed'", "license_reviewed_by=NULL", "license_reviewed_at=NULL", "license_note=NULL"] : []);
    const r = await one(c, `UPDATE learning_resources SET ${sets.join(", ")} WHERE id=$1 RETURNING *, created_by = eduos_ctx_user() AS yours`, [r0.id, ...cols.map(k => typeof b[k] === "string" ? b[k].trim() : b[k])]);
    await audit(c, req, "update", "learning_resource", r.id, `${cols.join(",")}${reReview ? ";licence back to review" : ""}`);
    return resourceOut(r, true);
  }));
  app.post("/api/resources/:id/license-review", limiter, requireSession, requireCsrf, run(async (c, req) => {
    manager(req);
    const r0 = await resourceOf(c, req.params.id), b = req.body || {};
    if (!["approved", "rejected"].includes(b.decision) || !cleanText(b.note, 1000, 3)) throw new HttpError(400, "decision_and_note_required", { hint: "decision: approved or rejected; note: what was checked (licence terms, redistribution, attribution)" });
    if (r0.status !== "draft") throw new HttpError(409, "only_drafts_change");
    if (r0.yours) throw new HttpError(409, "someone_else_reviews_the_licence");
    await c.query("UPDATE learning_resources SET license_status=$2, license_reviewed_by=$3, license_reviewed_at=now(), license_note=$4 WHERE id=$1", [r0.id, b.decision, req.actor.userId, b.note.trim()]);
    await audit(c, req, `license_${b.decision}`, "learning_resource", r0.id, b.note.trim().slice(0, 300));
    return { licenseStatus: b.decision };
  }));
  app.post("/api/resources/:id/publish", limiter, requireSession, requireCsrf, run(async (c, req) => {
    superintendent(req);
    const r0 = await resourceOf(c, req.params.id);
    if (r0.status !== "draft") throw new HttpError(409, "not_a_draft");
    if (r0.license_status !== "approved") throw new HttpError(409, "licence_not_approved");
    if (!r0.sha256) throw new HttpError(409, "checksum_required");
    await c.query("UPDATE learning_resources SET status='published', published_by=$2, published_at=now() WHERE id=$1", [r0.id, req.actor.userId]);
    await audit(c, req, "publish", "learning_resource", r0.id, `${r0.version};sha256=${r0.sha256}`);
    return { status: "published" };
  }));
  app.post("/api/resources/:id/retire", limiter, requireSession, requireCsrf, run(async (c, req) => {
    manager(req);
    const r0 = await resourceOf(c, req.params.id), why = req.body?.reason;
    if (!cleanText(why, 300, 3)) throw new HttpError(400, "reason_required");
    if (r0.status === "retired") throw new HttpError(409, "already_retired");
    await c.query("UPDATE learning_resources SET status='retired', retired_by=$2, retired_at=now(), retire_reason=$3 WHERE id=$1", [r0.id, req.actor.userId, why.trim()]);
    await audit(c, req, "retire", "learning_resource", r0.id, why.trim());
    return { status: "retired" };
  }));

  // ---------- collections ----------
  app.post("/api/resource-collections", limiter, requireSession, requireCsrf, run(async (c, req) => {
    manager(req);
    const b = req.body || {};
    if (!cleanText(b.name, 160, 2) || (b.description != null && (typeof b.description !== "string" || b.description.length > 2000)) || (b.reviewBy != null && !/^\d{4}-\d{2}-\d{2}$/.test(b.reviewBy)))
      throw new HttpError(400, "invalid_collection");
    const k = await one(c, "INSERT INTO learning_resource_collections(district_id, name, description, review_by, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [req.actor.districtId, b.name.trim(), b.description ?? null, b.reviewBy ?? null, req.actor.userId]);
    await audit(c, req, "create", "learning_resource_collection", k.id, b.name.trim());
    return { id: k.id };
  }, 201));
  app.post("/api/resource-collections/:id/items", limiter, requireSession, requireCsrf, run(async (c, req) => {
    manager(req);
    const k = await collectionOf(c, req.params.id);
    if (k.status !== "draft") throw new HttpError(409, "only_draft_collections_change");
    const r = await resourceOf(c, req.body?.resourceId);
    if (r.status === "retired") throw new HttpError(409, "resource_retired");
    const pos = (await one(c, "SELECT coalesce(max(position), 0) + 1 AS p FROM learning_resource_collection_items WHERE collection_id=$1", [k.id])).p;
    await c.query("INSERT INTO learning_resource_collection_items(district_id, collection_id, resource_id, position, added_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [req.actor.districtId, k.id, r.id, pos, req.actor.userId]);
    await audit(c, req, "add_item", "learning_resource_collection", k.id, r.id);
    return { added: true };
  }, 201));
  app.delete("/api/resource-collections/:id/items/:resourceId", limiter, requireSession, requireCsrf, run(async (c, req) => {
    manager(req);
    const k = await collectionOf(c, req.params.id);
    if (k.status !== "draft") throw new HttpError(409, "only_draft_collections_change");
    if (!validId(req.params.resourceId)) throw new HttpError(400, "invalid_id");
    const r = await c.query("DELETE FROM learning_resource_collection_items WHERE collection_id=$1 AND resource_id=$2", [k.id, req.params.resourceId]);
    if (!r.rowCount) throw new HttpError(404, "item_not_found");
    await audit(c, req, "remove_item", "learning_resource_collection", k.id, req.params.resourceId);
    return { removed: true };
  }));
  app.post("/api/resource-collections/:id/publish", limiter, requireSession, requireCsrf, run(async (c, req) => {
    superintendent(req);
    const k = await collectionOf(c, req.params.id);
    if (k.status !== "draft") throw new HttpError(409, "not_a_draft");
    const items = await rows(c, "SELECT r.status FROM learning_resource_collection_items i JOIN learning_resources r ON r.id=i.resource_id WHERE i.collection_id=$1", [k.id]);
    if (!items.length) throw new HttpError(409, "collection_is_empty");
    if (items.some(i => i.status !== "published")) throw new HttpError(409, "publish_every_resource_first");
    await c.query("UPDATE learning_resource_collections SET status='published', published_by=$2, published_at=now() WHERE id=$1", [k.id, req.actor.userId]);
    await audit(c, req, "publish", "learning_resource_collection", k.id, `items=${items.length}`);
    return { status: "published" };
  }));
  app.post("/api/resource-collections/:id/retire", limiter, requireSession, requireCsrf, run(async (c, req) => {
    manager(req);
    const k = await collectionOf(c, req.params.id);
    if (k.status === "retired") throw new HttpError(409, "already_retired");
    await c.query("UPDATE learning_resource_collections SET status='retired', retired_at=now() WHERE id=$1", [k.id]);
    await audit(c, req, "retire", "learning_resource_collection", k.id);
    return { status: "retired" };
  }));

  // ---------- school choice ----------
  app.get("/api/resource-collections/available", requireSession, run(async (c, req) => {
    lead(req);
    return (await rows(c, `SELECT k.id, k.name, k.description, k.review_by, (SELECT count(*)::int FROM learning_resource_collection_items i WHERE i.collection_id=k.id) AS items,
        EXISTS (SELECT 1 FROM learning_resource_school_selections s WHERE s.collection_id=k.id AND s.school_id=$1 AND s.removed_at IS NULL) AS selected
      FROM learning_resource_collections k WHERE k.status='published' ORDER BY k.name`, [req.actor.schoolId]))
      .map(k => ({ id: k.id, name: k.name, description: k.description, reviewBy: ymd(k.review_by), items: k.items, selected: k.selected }));
  }));
  app.post("/api/resource-collections/:id/select", limiter, requireSession, requireCsrf, run(async (c, req) => {
    lead(req);
    const k = await collectionOf(c, req.params.id);
    if (k.status !== "published") throw new HttpError(409, "collection_not_published");
    const r = await c.query(`INSERT INTO learning_resource_school_selections(district_id, school_id, collection_id, selected_by) VALUES ($1,$2,$3,$4)
      ON CONFLICT (school_id, collection_id) WHERE removed_at IS NULL DO NOTHING`, [req.actor.districtId, req.actor.schoolId, k.id, req.actor.userId]);
    if (r.rowCount) await audit(c, req, "select", "learning_resource_collection", k.id, `school=${req.actor.schoolId}`);
    return { selected: true };
  }));
  app.post("/api/resource-collections/:id/unselect", limiter, requireSession, requireCsrf, run(async (c, req) => {
    lead(req);
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const r = await c.query("UPDATE learning_resource_school_selections SET removed_by=$3, removed_at=now() WHERE collection_id=$1 AND school_id=$2 AND removed_at IS NULL",
      [req.params.id, req.actor.schoolId, req.actor.userId]);
    if (!r.rowCount) throw new HttpError(404, "not_selected");
    await audit(c, req, "unselect", "learning_resource_collection", req.params.id, `school=${req.actor.schoolId}`);
    return { selected: false };
  }));

  // ---------- browse ----------
  app.get("/api/resources", requireSession, run(async (c, req) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const subject = typeof req.query.subject === "string" ? req.query.subject.trim().slice(0, 80) : "";
    const type = TYPES.includes(req.query.type) ? req.query.type : null;
    const grade = GRADES.includes(req.query.grade) ? req.query.grade : null;
    const list = await rows(c, `SELECT r.* FROM learning_resources r WHERE r.status='published'
        AND ($1='' OR r.title ILIKE '%'||$2||'%' OR r.description ILIKE '%'||$2||'%') AND ($3='' OR $3 = ANY(r.subjects)) AND ($4::text IS NULL OR r.resource_type=$4)
        AND ($5::text IS NULL OR eduos_grade_rank($5) BETWEEN eduos_grade_rank(r.grade_min) AND eduos_grade_rank(r.grade_max))
      ORDER BY r.title LIMIT 200`, [q, q.replace(/[\\%_]/g, m => "\\" + m), subject, type, grade]);
    return list.map(r => resourceOut(r, false));
  }));
  app.get("/api/resources/:id", requireSession, run(async (c, req) => {
    const r = await resourceOf(c, req.params.id);
    return resourceOut(r, MANAGERS.includes(req.actor.role));
  }));
}
