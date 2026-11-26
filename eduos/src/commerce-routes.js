// EduOS 37.7.0 commerce routes. See docs/COMMERCE-SANDBOX.md and
// docs/COMMERCE-PROVIDERS.md. Paid checkout starts at POST
// /api/events/:id/tickets (clubs-sports-routes) for a priced ticket type;
// this file confirms and refunds payments, shows receipts and revenue, runs
// the district settings, and buys marketplace licenses on the 37.6 fee hook.
// 37.7.1: district administrators choose the payment processors
// (/api/commerce/providers...). Live payments stay off unless the server sets
// COMMERCE_LIVE_PAYMENTS_ENABLED=true.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission, canPerform } from "./policy.js";
import { config } from "./config.js";
import { audit, rows, one, validId, sendError } from "./role-app-util.js";
import { wrap, created, need, str, isoDate } from "./route-helpers.js";
import { withTenantTransaction } from "./db.js";
import { runAfterCommit } from "./commerce/phases.js";
import { SANDBOX_OUTCOMES } from "./commerce/payments.js";
import { summarize, DEFAULT_RATES } from "./commerce/split.js";
import { commerceStatus, loadSettings, settingsOut, confirmPayment, refundPayment, startMarketplaceCheckout, paymentOut, reconcileCommercePayments } from "./commerce/service.js";
import { providersOverview, saveAccount, testAccount, saveSetup, issueWebhookEndpoint, revokeWebhookEndpoint } from "./commerce/setup.js";
import { processCommerceWebhookEvents } from "./commerce/webhook-worker.js";

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const canPay = (req, res, next) => (canPerform(req.actor, "commerce", "pay") || canPerform(req.actor, "commerce", "purchase"))
  ? next() : res.status(403).json({ error: req.actor?.role === "pupil" ? "guardian_payment_required" : "forbidden", resource: "commerce", action: "pay" });

/**
 * Like wrap() (route-helpers), for routes that call a payment processor: the
 * request's transaction commits first, then the processor call deferred with
 * afterCommit() runs with no transaction open, and records its answer in a
 * transaction of its own. `then` shapes the final value (e.g. created()).
 */
const phased = (fn, then = x => x) => async (req, res, next) => {
  try {
    const out = then(await runAfterCommit(await withTenantTransaction(req.actor, c => fn(c, req))));
    res.setHeader("Cache-Control", "no-store");
    res.status(out?.__status || 200).json({ data: out?.__status ? out.data : out });
  } catch (e) {
    if (e?.code === "23505") return res.status(409).json({ error: "already_exists" });
    if (e?.code === "23514" || e?.code === "22P02" || e?.code === "22023" || e?.code === "22007" || e?.code === "22008") return res.status(400).json({ error: "invalid_value" });
    if (e?.code === "P0002") return res.status(404).json({ error: "not_found" });
    sendError(res, next, e);
  }
};

/**
 * COMMERCE_RECONCILE_INTERVAL_SECONDS (default 60; 0 = off): finish processor
 * calls that were cut off midway (see reconcileCommercePayments). A run still
 * going when the next is due is skipped. Started by the server on listen.
 */
let reconcileRunning = false;
export function startCommerceReconcile() {
  if (!config.commerceReconcileIntervalSeconds) return null;
  const timer = setInterval(() => {
    if (reconcileRunning) return;
    reconcileRunning = true;
    Promise.allSettled([reconcileCommercePayments(), processCommerceWebhookEvents()])
      .then(results => {
        if (results[0].status === "rejected") console.error("Commerce reconcile failed", { message: results[0].reason?.message });
        if (results[1].status === "rejected") console.error("Commerce webhook worker failed", { message: results[1].reason?.message });
      }).finally(() => { reconcileRunning = false; });
  }, config.commerceReconcileIntervalSeconds * 1000);
  timer.unref?.();
  return timer;
}

export function registerCommerceRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: config.commsRateLimit, standardHeaders: true, legacyHeaders: false });

  // Anyone signed in: is paid checkout on, and at what rates (shown on receipts).
  app.get("/api/commerce/status", requireSession, wrap(async (c, req) => {
    const s = await commerceStatus(c, req.actor.districtId);
    const ready = s.methods.filter(m => m.ready);
    return { provider: s.provider, live: s.live, sandbox: s.sandbox, enabled: s.enabled, settings: s.settings,
      methods: ready.map(m => ({ method: m.method, label: m.label, processor: m.processor, mode: m.mode, default: m.default })),
      defaultMethod: ready.some(m => m.method === s.defaultMethod) ? s.defaultMethod : (ready[0]?.method || null),
      canPay: canPerform(req.actor, "commerce", "pay") || canPerform(req.actor, "commerce", "purchase"),
      canManageProviders: canPerform(req.actor, "commerce", "providers"),
      note: !ready.length ? "No payment method is ready. Paid tickets are off."
        : s.live ? "Payments are live: real money moves." : s.sandbox ? "Sandbox only: no real money moves and no card is charged."
        : "Test mode: payments go to the processor's test system. No real money moves." };
  }));

  app.put("/api/commerce/settings", limiter, requireSession, requireCsrf, requirePermission("commerce", "settings"), wrap(async (c, req) => {
    const b = req.body || {}, cur = await loadSettings(c, req.actor.districtId);
    const v = {
      enabled: b.enabled === undefined ? cur.enabled : b.enabled,
      network_fee_bps: b.networkFeeBps ?? cur.network_fee_bps, sales_tax_bps: b.salesTaxBps ?? cur.sales_tax_bps,
      school_share_bps: b.split?.schoolBps ?? cur.school_share_bps, district_share_bps: b.split?.districtBps ?? cur.district_share_bps,
      state_share_bps: b.split?.stateBps ?? cur.state_share_bps,
      state_fund_label: b.stateFundLabel === undefined ? cur.state_fund_label : str(b.stateFundLabel, 120),
      marketplace_fee_bps: b.marketplaceFeeBps ?? cur.marketplace_fee_bps, hold_minutes: b.holdMinutes ?? cur.hold_minutes
    };
    need(typeof v.enabled === "boolean", 400, "invalid_value");
    need(intIn(v.network_fee_bps, 0, 1000) && intIn(v.sales_tax_bps, 0, 3000) && intIn(v.marketplace_fee_bps, 0, 3000) && intIn(v.hold_minutes, 2, 60), 400, "invalid_rate");
    need(intIn(v.school_share_bps, 0, 10000) && intIn(v.district_share_bps, 0, 10000) && intIn(v.state_share_bps, 0, 10000)
      && v.school_share_bps + v.district_share_bps + v.state_share_bps === 10000, 400, "split_must_total_100_percent");
    const r = await one(c, `INSERT INTO commerce_settings(district_id,enabled,network_fee_bps,sales_tax_bps,school_share_bps,district_share_bps,state_share_bps,
          state_fund_label,marketplace_fee_bps,hold_minutes,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
        ON CONFLICT(district_id) DO UPDATE SET enabled=EXCLUDED.enabled,network_fee_bps=EXCLUDED.network_fee_bps,sales_tax_bps=EXCLUDED.sales_tax_bps,
          school_share_bps=EXCLUDED.school_share_bps,district_share_bps=EXCLUDED.district_share_bps,state_share_bps=EXCLUDED.state_share_bps,
          state_fund_label=EXCLUDED.state_fund_label,marketplace_fee_bps=EXCLUDED.marketplace_fee_bps,hold_minutes=EXCLUDED.hold_minutes,
          updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
      [req.actor.districtId, v.enabled, v.network_fee_bps, v.sales_tax_bps, v.school_share_bps, v.district_share_bps, v.state_share_bps,
       v.state_fund_label, v.marketplace_fee_bps, v.hold_minutes, req.actor.userId]);
    await audit(c, req, "settings", "commerce", null,
      `enabled=${r.enabled};network=${r.network_fee_bps};tax=${r.sales_tax_bps};split=${r.school_share_bps}/${r.district_share_bps}/${r.state_share_bps};mkt=${r.marketplace_fee_bps};hold=${r.hold_minutes}`);
    return settingsOut(r);
  }));

  // Families: tickets on sale at their schools (priced and free).
  app.get("/api/commerce/shop", requireSession, wrap(async (c, req) => {
    need(["parent", "pupil"].includes(req.actor.role), 403, "ticket_buyer_role_required");
    await c.query("SELECT eduos_commerce_expire_holds()");
    const list = await rows(c, `SELECT e.id, e.event_kind, e.title, e.starts_at, e.venue, sc.name AS school_name, t.id AS type_id, t.name AS type_name, t.price_cents, t.currency,
        t.pass_kind, t.stream_season_id, ss.title AS stream_season_title,
        (SELECT es.access_mode FROM event_streams es WHERE es.event_id=e.id AND es.district_id=e.district_id ORDER BY es.created_at DESC LIMIT 1) AS stream_access_mode,
        (SELECT es.live_enabled FROM event_streams es WHERE es.event_id=e.id AND es.district_id=e.district_id ORDER BY es.created_at DESC LIMIT 1) AS stream_live_enabled,
        greatest(t.capacity - t.sold_count, 0) AS available
      FROM school_events e JOIN schools sc ON sc.id=e.school_id JOIN event_ticket_types t ON t.event_id=e.id AND t.sales_open
      LEFT JOIN school_stream_seasons ss ON ss.id=t.stream_season_id AND ss.district_id=t.district_id
      WHERE e.status='published' AND e.starts_at > now() ORDER BY e.starts_at, t.price_cents LIMIT 300`);
    const events = new Map();
    for (const r of list) {
      if (!events.has(r.id)) events.set(r.id, { id: r.id, eventKind: r.event_kind, title: r.title, startsAt: r.starts_at, venue: r.venue, school: r.school_name,
        hasStream: Boolean(r.stream_access_mode), streamAccessMode: r.stream_access_mode || null, streamLiveEnabled: Boolean(r.stream_live_enabled), ticketTypes: [] });
      events.get(r.id).ticketTypes.push({ id: r.type_id, name: r.type_name, priceCents: r.price_cents, currency: r.currency,
        passKind: r.pass_kind, streamSeasonId: r.stream_season_id || null, streamSeasonTitle: r.stream_season_title || null, available: r.available });
    }
    return { events: [...events.values()] };
  }));

  // The payer's own payments and receipts.
  app.get("/api/commerce/my", requireSession, canPay, wrap(async (c, req) => {
    const pays = await rows(c, `SELECT p.*, e.title AS event_title, l.name AS listing_name, o.quantity
        FROM commerce_payments p LEFT JOIN event_ticket_orders o ON o.id=p.ticket_order_id LEFT JOIN school_events e ON e.id=o.event_id
        LEFT JOIN marketplace_purchases m ON m.id=p.marketplace_purchase_id LEFT JOIN marketplace_listings l ON l.id=m.listing_id
       WHERE p.payer_user_id=$1 ORDER BY p.created_at DESC LIMIT 100`, [req.actor.userId]);
    const receipts = await rows(c, `SELECT id, payment_id, kind, receipt_number, amount_cents, currency, description, issued_at FROM commerce_receipts
       WHERE payer_user_id=$1 ORDER BY issued_at DESC LIMIT 200`, [req.actor.userId]);
    return { payments: pays.map(p => paymentOut(p, { title: p.event_title || p.listing_name, quantity: p.quantity ?? null,
      receipts: receipts.filter(r => r.payment_id === p.id).map(r => ({ id: r.id, kind: r.kind, number: r.receipt_number, amountCents: Number(r.amount_cents), issuedAt: r.issued_at })) })) };
  }));

  app.get("/api/commerce/receipts/:id", requireSession, wrap(async (c, req) => {
    need(validId(req.params.id), 400, "invalid_receipt_id");
    // RLS: the payer, the school's principal, the superintendent.
    const r = await one(c, `SELECT r.*, sc.name AS school_name, e.entry_hash, e.seq, p.provider, p.mode, p.payment_method FROM commerce_receipts r LEFT JOIN schools sc ON sc.id=r.school_id
        LEFT JOIN edal_entries e ON e.id=r.edal_entry_id LEFT JOIN commerce_payments p ON p.id=r.payment_id WHERE r.id=$1`, [req.params.id]);
    need(r, 404, "receipt_not_found");
    const s = await loadSettings(c, req.actor.districtId);
    await audit(c, req, "read", "commerce_receipt", r.id);
    return { id: r.id, number: r.receipt_number, kind: r.kind, amountCents: Number(r.amount_cents), currency: r.currency, description: r.description,
      school: r.school_name || null, issuedAt: r.issued_at, lines: r.lines, stateFundLabel: s.state_fund_label,
      edal: r.entry_hash ? { seq: Number(r.seq), entryHash: r.entry_hash } : null, sandbox: r.provider === "sandbox", mode: r.mode || "test", method: r.payment_method || "sandbox",
      note: r.provider === "sandbox" ? "Sandbox receipt: no real payment was taken."
        : r.mode === "live" ? "Paid through the district's payment processor." : "Test-mode receipt: the processor's test system, no real money." };
  }));

  app.post("/api/commerce/payments/:id/confirm", limiter, requireSession, requireCsrf, canPay, phased(async (c, req) => {
    need(validId(req.params.id), 400, "invalid_payment_id");
    // testOutcome applies to sandbox payments only; a processor payment is
    // confirmed by asking the processor.
    const outcome = req.body?.testOutcome;
    need(outcome === undefined || SANDBOX_OUTCOMES.includes(outcome), 400, "invalid_test_outcome", { allowed: SANDBOX_OUTCOMES });
    return confirmPayment(c, req, req.params.id, outcome);
  }));

  app.post("/api/commerce/payments/:id/refund", limiter, requireSession, requireCsrf, requirePermission("commerce", "refund"), phased(async (c, req) => {
    need(validId(req.params.id), 400, "invalid_payment_id");
    return refundPayment(c, req, req.params.id);
  }));

  // Leaders: revenue by line and recent payments (principal: own school).
  app.get("/api/commerce/report", requireSession, requirePermission("commerce", "report"), wrap(async (c, req) => {
    const a = req.actor, from = req.query.from, to = req.query.to;
    need((from === undefined || isoDate(from)) && (to === undefined || isoDate(to)), 400, "invalid_date");
    const school = a.role === "principal" ? a.schoolId : null;
    const args = [school, from || "1970-01-01", to || "9999-12-31"];
    const lines = await rows(c, `SELECT l.line, l.school_id, sum(l.amount_cents)::bigint AS amount_cents FROM commerce_ledger_entries l
       WHERE ($1::uuid IS NULL OR l.school_id=$1) AND l.created_at >= $2::date AND l.created_at < $3::date + 1 GROUP BY l.line, l.school_id`, args);
    const schools = await rows(c, `SELECT id, name FROM schools WHERE ($1::uuid IS NULL OR id=$1) ORDER BY name`, [school]);
    const bySchool = schools.map(s => ({ id: s.id, name: s.name, totals: summarize(lines.filter(l => l.school_id === s.id).map(l => ({ line: l.line, amount: Number(l.amount_cents) }))) }))
      .filter(s => Object.keys(s.totals).length);
    const totals = summarize(lines.map(l => ({ line: l.line, amount: Number(l.amount_cents) })));
    const payments = await rows(c, `SELECT p.*, u.display_name AS payer_name, e.title AS event_title, l.name AS listing_name, o.quantity,
        (SELECT count(*)::int FROM event_tickets t WHERE t.order_id=o.id AND t.status='checked_in') AS checked_in
        FROM commerce_payments p JOIN users u ON u.id=p.payer_user_id LEFT JOIN event_ticket_orders o ON o.id=p.ticket_order_id
        LEFT JOIN school_events e ON e.id=o.event_id LEFT JOIN marketplace_purchases m ON m.id=p.marketplace_purchase_id
        LEFT JOIN marketplace_listings l ON l.id=m.listing_id
       WHERE ($1::uuid IS NULL OR p.school_id=$1) AND p.created_at >= $2::date AND p.created_at < $3::date + 1
         AND p.status IN ('succeeded','refund_pending','refunded') ORDER BY p.created_at DESC LIMIT 200`, args);
    const s = await commerceStatus(c, a.districtId);
    await audit(c, req, "report", "commerce", null, `school=${school || "all"};payments=${payments.length}`);
    return { scope: school ? "school" : "district", status: { provider: s.provider, enabled: s.enabled, settings: s.settings }, totals, bySchool,
      districtTotals: school ? null : summarize(lines.filter(l => l.school_id === null).map(l => ({ line: l.line, amount: Number(l.amount_cents) }))),
      payments: payments.map(p => paymentOut(p, { payer: p.payer_name, title: p.event_title || p.listing_name, quantity: p.quantity ?? null,
        refundable: p.status === "succeeded" && !p.checked_in && (a.role === "superintendent" || p.purpose === "event_tickets") })) };
  }));

  // Marketplace (district): price a listing, see approved licenses, pay.
  app.post("/api/commerce/marketplace/listings/:id/price", limiter, requireSession, requireCsrf, requirePermission("commerce", "settings"), wrap(async (c, req) => {
    need(validId(req.params.id), 400, "invalid_listing_id");
    const b = req.body || {}, price = b.unitPriceCents ?? null, unit = b.priceUnit ?? "seat";
    need((price === null || intIn(price, 1, 10_000_000)) && ["seat", "flat"].includes(unit), 400, "invalid_price");
    const r = await one(c, "UPDATE marketplace_listings SET unit_price_cents=$2, price_unit=$3 WHERE id=$1 RETURNING id, unit_price_cents, price_unit", [req.params.id, price, unit]);
    need(r, 404, "listing_not_found");
    await audit(c, req, "price", "marketplace_listing", r.id, `cents=${price ?? "none"};unit=${unit}`);
    return { id: r.id, unitPriceCents: r.unit_price_cents, priceUnit: r.price_unit };
  }));
  app.get("/api/commerce/marketplace", requireSession, requirePermission("commerce", "purchase"), wrap(async (c, req) => {
    const list = await rows(c, `SELECT f.id, f.created_at, l.id AS listing_id, l.name, v.name AS vendor, l.unit_price_cents, l.price_unit, lic.seat_limit,
        (SELECT row_to_json(x) FROM (SELECT m.id, m.status, m.total_cents, m.quantity FROM marketplace_purchases m WHERE m.fee_event_id=f.id
           ORDER BY m.created_at DESC LIMIT 1) x) AS purchase
      FROM marketplace_fee_events f JOIN marketplace_listings l ON l.id=f.listing_id JOIN marketplace_vendors v ON v.id=l.vendor_id
      LEFT JOIN app_licenses lic ON lic.id=f.license_id ORDER BY f.created_at DESC LIMIT 200`);
    const s = await loadSettings(c, req.actor.districtId);
    return { marketplaceFeeBps: s.marketplace_fee_bps, defaultFeeBps: DEFAULT_RATES.marketplaceFeeBps, licenses: list.map(f => ({ feeEventId: f.id, approvedAt: f.created_at,
      listingId: f.listing_id, name: f.name, vendor: f.vendor, unitPriceCents: f.unit_price_cents, priceUnit: f.price_unit, seatLimit: f.seat_limit, purchase: f.purchase })) };
  }));
  app.post("/api/commerce/marketplace/fee-events/:id/checkout", limiter, requireSession, requireCsrf, requirePermission("commerce", "purchase"), phased(async (c, req) => {
    need(validId(req.params.id), 400, "invalid_fee_event_id");
    return startMarketplaceCheckout(c, req, req.params.id, req.body || {});
  }, r => (r.replayed ? r : created(r))));

  // 37.7.1 District payment providers (superintendent and district IT).
  // Credentials are write-only: responses say which secrets are set, never
  // their values.
  const provAdmin = [limiter, requireSession, requireCsrf, requirePermission("commerce", "providers")];
  app.get("/api/commerce/providers", requireSession, requirePermission("commerce", "providers"), wrap(async (c, req) => providersOverview(c, req.actor.districtId)));
  // Provider administrators can inspect terminal webhook failures without
  // exposing callback payloads, endpoint tokens, or payer identity.
  app.get("/api/commerce/providers/webhook-refund-cases", requireSession, requirePermission("commerce", "providers"), wrap(async c => {
    const cases = await rows(c, `
      SELECT id,payment_id,webhook_event_id,processor,provider_capture_ref,amount_cents,
             currency,reason_code,status,opened_at,last_seen_at,resolved_at,resolution_note
        FROM commerce_webhook_refund_cases
       WHERE status='open'
       ORDER BY opened_at ASC,id ASC
       LIMIT 100
    `);
    return { refundCases: cases.map(x => ({
      id:x.id,paymentId:x.payment_id,webhookEventId:x.webhook_event_id,
      processor:x.processor,captureRef:x.provider_capture_ref,amountCents:x.amount_cents,
      currency:x.currency,reasonCode:x.reason_code,status:x.status,
      openedAt:x.opened_at,lastSeenAt:x.last_seen_at
    })) };
  }));
  app.post("/api/commerce/providers/webhook-refund-cases/:id/resolve", ...provAdmin, wrap(async (c, req) => {
    need(validId(req.params.id), 400, "invalid_refund_case_id");
    const note = req.body?.resolutionNote;
    need(typeof note === "string" && note.trim().length >= 10 && note.trim().length <= 1000,
      400, "resolution_note_required");
    const resolved = await one(c, `
      UPDATE commerce_webhook_refund_cases
         SET status='resolved',resolved_at=now(),resolved_by=$2,resolution_note=$3
       WHERE id=$1 AND status='open'
       RETURNING id,payment_id
    `, [req.params.id, req.actor.userId, note.trim()]);
    need(resolved, 404, "refund_case_not_found");
    await audit(c, req, "late_capture_refund_resolved", "commerce_webhook_refund_case",
      resolved.id, `payment=${resolved.payment_id};resolution=${note.trim().slice(0,500)}`);
    return { id: resolved.id, status: "resolved" };
  }));
  app.get("/api/commerce/providers/webhook-dead-letters", requireSession, requirePermission("commerce", "providers"), wrap(async c => {
    const events = await rows(c, `
      SELECT e.id, e.payment_id, e.processor, e.provider_event_id, e.event_type,
             e.attempts, e.last_error_code, e.received_at, e.processed_at
        FROM commerce_webhook_events e
       WHERE e.state='dead_letter'
       ORDER BY e.processed_at DESC, e.id DESC
       LIMIT 100
    `);
    return { deadLetters: events.map(e => ({
      id: e.id, paymentId: e.payment_id, processor: e.processor,
      providerEventId: e.provider_event_id, eventType: e.event_type,
      attempts: e.attempts, errorCode: e.last_error_code,
      receivedAt: e.received_at, processedAt: e.processed_at
    })) };
  }));
  app.put("/api/commerce/providers/:processor", ...provAdmin, wrap(async (c, req) => saveAccount(c, req, req.params.processor, req.body || {})));
  app.post("/api/commerce/providers/:processor/test", ...provAdmin, phased(async (c, req) => testAccount(c, req, req.params.processor)));
  // Endpoint URLs contain one-time bearer tokens; wrap() applies Cache-Control: no-store.
  app.post("/api/commerce/providers/:processor/webhook-endpoint", ...provAdmin,
    wrap(async (c, req) => created(await issueWebhookEndpoint(c, req, req.params.processor))));
  app.post("/api/commerce/providers/:processor/webhook-endpoint/rotate", ...provAdmin,
    wrap(async (c, req) => issueWebhookEndpoint(c, req, req.params.processor)));
  app.delete("/api/commerce/providers/:processor/webhook-endpoint", ...provAdmin,
    wrap(async (c, req) => revokeWebhookEndpoint(c, req, req.params.processor)));
  app.put("/api/commerce/payment-methods", ...provAdmin, wrap(async (c, req) => saveSetup(c, req, req.body || {})));
}
