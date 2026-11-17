// EduOS 37.6.0 marketplace: the 32.2 app catalog grows vendor listings with a
// district privacy review. Principals and teachers request a listing; the
// district approves it through the EXISTING licensing (apps -> app_licenses ->
// app_assignments) and the existing app_requests queue. Nothing can be
// requested or approved until the privacy review is "approved" (also enforced
// by a trigger on app_requests). recordVendorFee() is a placeholder hook.
//
// Permissions reuse the existing apps:* set: browse = apps:request or
// apps:manage; vendors, listings and privacy review = apps:manage (district);
// request = apps:request; approve = apps:decide.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission, canPerform, isDistrictRole } from "./policy.js";
import { config } from "./config.js";
import { audit, rows, one, validId, HttpError } from "./role-app-util.js";
import { wrap, created, need, str, isoDate } from "./route-helpers.js";
import { recordVendorFee } from "./marketplace/fees.js";
import { CHECKLIST } from "./marketplace/checklist.js";
import { enqueueNotifications, registerNotificationKind } from "./notify.js";

registerNotificationKind("marketplace");
const KEYS = CHECKLIST.map(c => c[0]);
const STATUSES = ["in_review", "changes_requested", "approved", "rejected"];
const SCOPES = ["none", "identity", "roster_basic", "roster_full"];
const canBrowse = (req, res, next) => (canPerform(req.actor, "apps", "request") || canPerform(req.actor, "apps", "manage")) ? next() : res.status(403).json({ error: "forbidden", resource: "apps", action: "request" });

function listingOut(l, extra = {}) {
  return { id: l.id, name: l.name, vendor: l.vendor_name, vendorId: l.vendor_id, category: l.category, description: l.description, gradeLevels: l.grade_levels,
    integrationType: l.integration_type, launchUrl: l.launch_url, dataSharingScope: l.data_sharing_scope, pricingNote: l.pricing_note,
    privacy: { status: l.privacy_status, checklist: l.privacy_checklist, notes: l.privacy_notes, dpaExpiresOn: l.dpa_expires_on, reviewedAt: l.reviewed_at, reviewedBy: l.reviewer_name || null },
    appId: l.app_id, status: l.status, ...extra };
}
const dpaExpired = l => Boolean(l.dpa_expires_on) && new Date(l.dpa_expires_on) < new Date(new Date().toISOString().slice(0, 10));

export function registerMarketplaceRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: config.commsRateLimit, standardHeaders: true, legacyHeaders: false });

  app.get("/api/marketplace", requireSession, canBrowse, wrap(async (client, req) => {
    const district = isDistrictRole(req.actor.role);
    const list = await rows(client, `SELECT l.*, v.name AS vendor_name, u.display_name AS reviewer_name FROM marketplace_listings l
        JOIN marketplace_vendors v ON v.id=l.vendor_id LEFT JOIN users u ON u.id=l.reviewed_by ORDER BY l.name`);
    const reqs = await rows(client, `SELECT r.id,r.listing_id,r.school_id,sc.name AS school_name,r.status,r.reason,r.requested_scope,r.seats_requested,r.created_at,
        r.decided_at,u.display_name AS requested_by_name FROM app_requests r JOIN schools sc ON sc.id=r.school_id JOIN users u ON u.id=r.requested_by
       WHERE r.listing_id IS NOT NULL AND ($1 OR r.school_id=$2) ORDER BY r.created_at DESC`, [district, req.actor.schoolId || null]);
    const reviews = district ? await rows(client, `SELECT p.listing_id,p.from_status,p.to_status,p.note,p.at,u.display_name FROM marketplace_privacy_reviews p
        JOIN users u ON u.id=p.reviewer ORDER BY p.at DESC LIMIT 200`) : [];
    const vendors = district ? await rows(client, `SELECT id,name,website,contact_email,status FROM marketplace_vendors ORDER BY name`) : [];
    await audit(client, req, "read", "marketplace", null, `listings=${list.length}`);
    return { checklist: CHECKLIST.map(([key, label]) => ({ key, label })), vendors, canManage: canPerform(req.actor, "apps", "manage"),
      canDecide: canPerform(req.actor, "apps", "decide"), canRequest: canPerform(req.actor, "apps", "request"),
      feeAccounting: "Fee accounting is not built yet. Approvals are recorded as deferred fee events only (no amounts, no payments).",
      listings: list.map(l => listingOut(l, {
        requests: reqs.filter(r => r.listing_id === l.id).map(r => ({ id: r.id, school: r.school_name, status: r.status, reason: r.reason, scope: r.requested_scope,
          seats: r.seats_requested, requestedBy: r.requested_by_name, createdAt: r.created_at, decidedAt: r.decided_at })),
        reviews: reviews.filter(r => r.listing_id === l.id).map(r => ({ from: r.from_status, to: r.to_status, note: r.note, at: r.at, by: r.display_name })),
        requestable: l.privacy_status === "approved" && l.status === "listed" && !dpaExpired(l) })) };
  }));

  app.post("/api/marketplace/vendors", limiter, requireSession, requireCsrf, requirePermission("apps", "manage"), wrap(async (client, req) => {
    const b = req.body || {};
    const name = str(b.name, 120);
    need(b.website == null || b.website === "" || /^https:\/\/\S{3,300}$/.test(b.website), 400, "invalid_website");
    const email = str(b.contactEmail, 200, { optional: true });
    need(email == null || /^[^@\s]+@[^@\s]+$/.test(email), 400, "invalid_email");
    const r = await one(client, `INSERT INTO marketplace_vendors(district_id,name,website,contact_email,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [req.actor.districtId, name, b.website || null, email, req.actor.userId]);
    await audit(client, req, "create", "marketplace_vendor", r.id, name);
    return created({ id: r.id });
  }));
  app.post("/api/marketplace/listings", limiter, requireSession, requireCsrf, requirePermission("apps", "manage"), wrap(async (client, req) => {
    const b = req.body || {};
    need(validId(b.vendorId), 400, "invalid_vendor_id");
    need(/^https:\/\/\S{3,500}$/.test(b.launchUrl || ""), 400, "invalid_launch_url");
    need(SCOPES.includes(b.dataSharingScope ?? "none") && ["link", "oidc_sso", "lti13"].includes(b.integrationType ?? "link"), 400, "invalid_value");
    const grades = Array.isArray(b.gradeLevels) ? b.gradeLevels.map(String).filter(g => /^(PK|K|[0-9]{1,2})$/.test(g)).slice(0, 15) : [];
    const r = await one(client, `INSERT INTO marketplace_listings(district_id,vendor_id,name,category,description,grade_levels,integration_type,launch_url,data_sharing_scope,pricing_note,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [req.actor.districtId, b.vendorId, str(b.name, 120), str(b.category, 40), str(b.description, 1000), grades, b.integrationType ?? "link", b.launchUrl,
       b.dataSharingScope ?? "none", str(b.pricingNote, 300, { optional: true }), req.actor.userId]);
    await audit(client, req, "create", "marketplace_listing", r.id);
    return created({ id: r.id, privacyStatus: "not_reviewed" });
  }));
  app.post("/api/marketplace/listings/:id/status", limiter, requireSession, requireCsrf, requirePermission("apps", "manage"), wrap(async (client, req) => {
    need(validId(req.params.id) && ["listed", "unlisted"].includes(req.body?.status), 400, "invalid_value");
    const r = await client.query(`UPDATE marketplace_listings SET status=$2 WHERE id=$1 RETURNING id`, [req.params.id, req.body.status]);
    need(r.rowCount, 404, "not_found");
    await audit(client, req, `listing.${req.body.status}`, "marketplace_listing", req.params.id);
    return { id: req.params.id, status: req.body.status };
  }));

  // Privacy review: every checklist item must be true to approve.
  app.post("/api/marketplace/listings/:id/review", limiter, requireSession, requireCsrf, requirePermission("apps", "manage"), wrap(async (client, req) => {
    need(validId(req.params.id), 400, "invalid_listing_id");
    const b = req.body || {};
    need(STATUSES.includes(b.status), 400, "invalid_status");
    const l = await one(client, `SELECT * FROM marketplace_listings WHERE id=$1 FOR UPDATE`, [req.params.id]);
    need(l, 404, "not_found");
    const checklist = Object.fromEntries(KEYS.map(k => [k, b.checklist?.[k] === true]));
    const missing = KEYS.filter(k => !checklist[k]);
    if (b.status === "approved" && missing.length) throw new HttpError(409, "checklist_incomplete", { missing });
    const note = str(b.note, 1000, { optional: true });
    if (["changes_requested", "rejected"].includes(b.status)) need(note, 400, "note_required");
    need(b.dpaExpiresOn == null || b.dpaExpiresOn === "" || isoDate(b.dpaExpiresOn), 400, "invalid_dpa_date");
    const dpa = b.dpaExpiresOn || l.dpa_expires_on;
    await client.query(`INSERT INTO marketplace_privacy_reviews(district_id,listing_id,from_status,to_status,checklist,note,reviewer) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [req.actor.districtId, l.id, l.privacy_status, b.status, checklist, note, req.actor.userId]);
    await client.query(`UPDATE marketplace_listings SET privacy_status=$2, privacy_checklist=$3, privacy_notes=COALESCE($4,privacy_notes), dpa_expires_on=$5,
        reviewed_by=$6, reviewed_at=now() WHERE id=$1`, [l.id, b.status, checklist, note, dpa, req.actor.userId]);
    await audit(client, req, `privacy.${b.status}`, "marketplace_listing", l.id, missing.length ? `missing=${missing.join(",")}` : null);
    return { id: l.id, privacyStatus: b.status, missing };
  }));

  // School request -> the existing app_requests queue, tied to the listing.
  app.post("/api/marketplace/listings/:id/request", limiter, requireSession, requireCsrf, requirePermission("apps", "request"), wrap(async (client, req) => {
    need(validId(req.params.id), 400, "invalid_listing_id");
    need(req.actor.schoolId, 400, "school_required");
    const l = await one(client, `SELECT l.*, v.name AS vendor_name FROM marketplace_listings l JOIN marketplace_vendors v ON v.id=l.vendor_id WHERE l.id=$1`, [req.params.id]);
    need(l, 404, "not_found");
    if (l.privacy_status !== "approved" || l.status !== "listed") throw new HttpError(409, "privacy_review_not_approved", { privacyStatus: l.privacy_status });
    if (dpaExpired(l)) throw new HttpError(409, "dpa_expired");
    const scope = req.body?.scope === "district" && req.actor.role === "principal" ? "district" : "school";
    const seats = req.body?.seats == null || req.body?.seats === "" ? null : Number(req.body.seats);
    need(seats === null || (Number.isInteger(seats) && seats >= 1 && seats <= 100000), 400, "invalid_seats");
    const dup = await one(client, `SELECT 1 AS x FROM app_requests WHERE school_id=$1 AND listing_id=$2 AND status='pending'`, [req.actor.schoolId, l.id]);
    if (dup) throw new HttpError(409, "request_already_pending");
    const r = await one(client, `INSERT INTO app_requests(district_id,school_id,requested_by,app_id,requested_name,requested_vendor,requested_url,reason,listing_id,requested_scope,seats_requested)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [req.actor.districtId, req.actor.schoolId, req.actor.userId, l.app_id, l.name, l.vendor_name, l.launch_url, str(req.body?.reason, 2000), l.id, scope, seats]);
    await audit(client, req, "request", "app_request", r.id, `listing=${l.id}`);
    const deciders = await rows(client, `SELECT DISTINCT user_id FROM memberships WHERE role IN ('superintendent','it_admin') AND status='active'`);
    await enqueueNotifications(client, { districtId: req.actor.districtId, schoolId: null, recipients: deciders.map(d => d.user_id), kind: "marketplace",
      title: `App request: ${l.name}`, body: "A school asked for a marketplace app. Review it in Marketplace.", refType: "app_request", refId: r.id });
    return created({ id: r.id, status: "pending" });
  }));

  // District approval: app (created from the listing once) -> license -> assignment, plus the fee hook.
  app.post("/api/marketplace/requests/:id/approve", limiter, requireSession, requireCsrf, requirePermission("apps", "decide"), wrap(async (client, req) => {
    need(validId(req.params.id), 400, "invalid_request_id");
    const q = await one(client, `SELECT * FROM app_requests WHERE id=$1 AND listing_id IS NOT NULL FOR UPDATE`, [req.params.id]);
    need(q, 404, "request_not_found");
    if (q.status !== "pending") throw new HttpError(409, "request_not_pending");
    const l = await one(client, `SELECT l.*, v.name AS vendor_name FROM marketplace_listings l JOIN marketplace_vendors v ON v.id=l.vendor_id WHERE l.id=$1 FOR UPDATE`, [q.listing_id]);
    if (l.privacy_status !== "approved") throw new HttpError(409, "privacy_review_not_approved", { privacyStatus: l.privacy_status });
    if (dpaExpired(l)) throw new HttpError(409, "dpa_expired");
    const b = req.body || {};
    const seatLimit = b.seatLimit == null || b.seatLimit === "" ? q.seats_requested : Number(b.seatLimit);
    need(seatLimit === null || (Number.isInteger(seatLimit) && seatLimit > 0), 400, "invalid_seats");
    need(b.endsOn == null || b.endsOn === "" || isoDate(b.endsOn), 400, "invalid_end_date");
    let appId = l.app_id;
    if (!appId) {
      const existing = await one(client, `SELECT id FROM apps WHERE lower(name)=lower($1) AND status='active'`, [l.name]);
      appId = existing?.id || (await one(client, `INSERT INTO apps(district_id,name,vendor,description,category,launch_url,integration_type,data_sharing_scope,dpa_status,dpa_expires_on,
          coppa_compliant,ferpa_school_official,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'signed',$9,true,true,$10) RETURNING id`,
        [req.actor.districtId, l.name, l.vendor_name, l.description, l.category, l.launch_url, l.integration_type, l.data_sharing_scope, l.dpa_expires_on, req.actor.userId])).id;
      await client.query(`UPDATE marketplace_listings SET app_id=$2 WHERE id=$1`, [l.id, appId]);
    }
    // District-purchased license (purchased_by_school_id NULL), the same licensing every catalog app uses.
    const lic = await one(client, `INSERT INTO app_licenses(district_id,app_id,purchased_by_school_id,seat_limit,ends_on,note,created_by) VALUES($1,$2,NULL,$3,$4,$5,$6) RETURNING id`,
      [req.actor.districtId, appId, seatLimit, b.endsOn || null, `Marketplace request ${q.id.slice(0, 8)}`, req.actor.userId]);
    const asg = await one(client, `INSERT INTO app_assignments(district_id,app_id,scope,school_id,assigned_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
      [req.actor.districtId, appId, q.requested_scope, q.requested_scope === "district" ? null : q.school_id, req.actor.userId]);
    await client.query(`UPDATE app_requests SET status='approved', app_id=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1`,
      [q.id, appId, req.actor.userId, str(b.note, 1000, { optional: true })]);
    const fee = await recordVendorFee(client, { districtId: req.actor.districtId, listingId: l.id, licenseId: lic.id, userId: req.actor.userId });
    await audit(client, req, "approve", "app_request", q.id, `listing=${l.id};app=${appId};license=${lic.id}`);
    await enqueueNotifications(client, { districtId: req.actor.districtId, schoolId: q.school_id, recipients: [q.requested_by], kind: "marketplace",
      title: `Approved: ${l.name}`, body: "The district approved your app request. It is now in your apps.", refType: "app_request", refId: q.id });
    return { id: q.id, status: "approved", appId, licenseId: lic.id, assignmentId: asg?.id || null, fee };
  }));
}
