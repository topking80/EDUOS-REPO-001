// EduOS 37.7.0 commerce service: paid ticket checkout with inventory holds,
// payment confirmation, refunds, marketplace purchases, and the settlement ->
// EDAL -> ledger -> receipt record. Every amount is integer cents; every
// write is in the caller's tenant transaction under RLS.
// 37.7.1: the processor is the district's choice (src/commerce/setup.js):
// the built-in sandbox confirms instantly; PayPal, Square and BTCPay send the
// payer to their own hosted page and confirm when the payer comes back.
// No processor call runs inside a database transaction: each is reserve and
// commit, call the processor (idempotent, keyed by the payment id), then
// record the answer in a new transaction (src/commerce/phases.js). A call cut
// off midway (crash, deploy) is finished by reconcileCommercePayments().
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { pool, withTenantTransaction } from "../db.js";
import { afterCommit } from "./phases.js";
import { ProviderError } from "./adapters.js";
import { resolveCheckout, adapterFor, checkoutMethods } from "./setup.js";
import { ticketSettlement, marketplaceSettlement, DEFAULT_RATES, formatCents } from "./split.js";
import { appendEntry } from "../edal.js";
import { qrRows } from "../pickup-routes.js";
import { audit, one, rows, HttpError } from "../role-app-util.js";

const DEFAULTS = Object.freeze({ enabled: false, network_fee_bps: DEFAULT_RATES.networkFeeBps, sales_tax_bps: DEFAULT_RATES.salesTaxBps,
  school_share_bps: DEFAULT_RATES.split.school, district_share_bps: DEFAULT_RATES.split.district, state_share_bps: DEFAULT_RATES.split.state,
  state_fund_label: "State education fund", marketplace_fee_bps: DEFAULT_RATES.marketplaceFeeBps, hold_minutes: 10, updated_at: null });

export function settingsOut(s) {
  return { enabled: s.enabled, networkFeeBps: s.network_fee_bps, salesTaxBps: s.sales_tax_bps,
    split: { schoolBps: s.school_share_bps, districtBps: s.district_share_bps, stateBps: s.state_share_bps }, stateFundLabel: s.state_fund_label,
    marketplaceFeeBps: s.marketplace_fee_bps, holdMinutes: s.hold_minutes, updatedAt: s.updated_at };
}
export async function loadSettings(c, districtId) {
  return (await one(c, "SELECT * FROM commerce_settings WHERE district_id=$1", [districtId])) || { ...DEFAULTS };
}
/** What every screen needs: is paid checkout on, through which methods, at what rates. */
export async function commerceStatus(c, districtId) {
  const s = await loadSettings(c, districtId);
  const cm = await checkoutMethods(c, districtId);
  const ready = cm.methods.filter(m => m.ready), main = ready.find(m => m.default) || ready[0];
  return { provider: main?.processor || "none", live: ready.some(m => m.mode === "live"), sandbox: ready.length > 0 && ready.every(m => m.processor === "sandbox"),
    enabled: s.enabled && ready.length > 0, methods: cm.methods, defaultMethod: cm.defaultMethod, settings: settingsOut(s), raw: s };
}
const disabledReason = st => !st.raw.enabled ? "district_commerce_disabled" : "district_payment_provider_not_connected";
const methodOf = b => { const m = b?.paymentMethod; if (m !== undefined && m !== null && (typeof m !== "string" || m.length > 20)) throw new HttpError(400, "invalid_payment_method"); return m ?? undefined; };
// Where the hosted page sends the payer back. The app confirms on arrival.
const returnUrls = (paymentId, view) => ({ returnUrl: `${config.publicOrigin}/app/?commerce_return=${paymentId}#/${view}`,
  cancelUrl: `${config.publicOrigin}/app/?commerce_return=${paymentId}&commerce_cancel=1#/${view}` });
const rates = s => ({ salesTaxBps: s.sales_tax_bps, networkFeeBps: s.network_fee_bps,
  split: { school: s.school_share_bps, district: s.district_share_bps, state: s.state_share_bps } });
const jsonLines = lines => lines.map(l => (l.recipientId ? { line: l.line, recipient: l.recipient, amount: l.amount, recipientId: l.recipientId }
  : { line: l.line, recipient: l.recipient, amount: l.amount }));
const newCode = () => { const code = randomBytes(24).toString("base64url"); return { code, hash: createHash("sha256").update(code).digest("hex") }; };
function feesGuard(fn) {
  try { return fn(); } catch (e) { if (e.code === "fees_exceed_price") throw new HttpError(409, "price_below_fees", { reason: "The fees would be more than the price." }); throw e; }
}
export function paymentOut(p, extra = {}) {
  return { id: p.id, purpose: p.purpose, status: p.status, amountCents: p.amount_cents, currency: p.currency,
    processingFeeCents: p.processing_fee_cents, provider: p.provider, sandbox: p.provider === "sandbox", method: p.payment_method || "sandbox",
    mode: p.mode || "test", test: (p.mode || "test") === "test", redirectUrl: p.status === "requires_confirmation" ? p.checkout_url || null : null, createdAt: p.created_at,
    confirmedAt: p.confirmed_at || null, refundedAt: p.refunded_at || null, ...extra };
}

/** Record a settlement or refund: EDAL entry, then ledger lines + receipt (db/065). */
async function record(c, actor, p, kind, lines, description) {
  const payloadLines = jsonLines(lines);
  const entry = await appendEntry(c, actor, { kind: `commerce_${kind}`, schoolId: p.school_id || null, studentId: null,
    payload: { paymentId: p.id, purpose: p.purpose, currency: p.currency, lines: payloadLines } });
  const r = await one(c, "SELECT receipt_id, receipt_number FROM eduos_commerce_record($1,$2,$3,$4::jsonb,$5)",
    [p.id, kind, entry.id, JSON.stringify(payloadLines), description]);
  return { id: r.receipt_id, number: r.receipt_number, edal: { id: entry.id, seq: entry.seq, entryHash: entry.entryHash } };
}

// ---------------- shared two-phase plumbing ----------------

const actorJson = a => JSON.stringify({ userId: a.userId, role: a.role, schoolId: a.schoolId || null });
const viewOf = p => (p.purpose === "event_tickets" ? "tickets" : "commerce");
/** The processor's error as the HTTP answer (502 + its code); anything else unchanged. */
const asHttp = (e, processor) => (e instanceof ProviderError ? new HttpError(502, e.code, { processor }) : e);
/** Run a processor call with no transaction open; never throws, returns { ok, value | error }. */
async function outside(fn) {
  try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error }; }
}
const tx = (a, fn) => withTenantTransaction(a, fn);
const adapterOf = async (a, p, given) => given || (await tx(a, c => adapterFor(c, a.districtId, p.provider, { forCheckout: false }))).adapter;
const auditNote = req => (req.reconciled ? ";reconciled=true" : "");

/** Release what a checkout held when its processor never created the payment. */
async function releaseHold(c, p) {
  if (p.purpose === "event_tickets") {
    const o = await one(c, "SELECT id, status, ticket_type_id, quantity FROM event_ticket_orders WHERE id=$1 FOR UPDATE", [p.ticket_order_id]);
    if (o?.status === "payment_pending") {
      await c.query("UPDATE event_ticket_orders SET status='cancelled' WHERE id=$1", [o.id]);
      await c.query("UPDATE event_ticket_types SET sold_count=greatest(sold_count-$2,0) WHERE id=$1", [o.ticket_type_id, o.quantity]);
    }
  } else {
    await c.query("UPDATE marketplace_purchases SET status='cancelled' WHERE id=$1 AND status='payment_pending'", [p.marketplace_purchase_id]);
  }
}

/**
 * Phase 2 of a checkout: ask the processor for its hosted page (outside any
 * transaction), then record it. The idempotency key is the payment id, so a
 * retry (a replayed request, or the reconcile sweep) gets the same order,
 * payment link or invoice back instead of a second one.
 */
export async function finishCreate(req, paymentId, given = null) {
  const a = req.actor;
  const p = await tx(a, c => one(c, "SELECT * FROM commerce_payments WHERE id=$1", [paymentId]));
  if (!p) throw new HttpError(404, "payment_not_found");
  if (p.status !== "creating") return p;
  const adapter = await adapterOf(a, p, given);
  const r = await outside(() => adapter.createPayment({ amountCents: p.amount_cents, currency: p.currency, reference: p.id, method: p.payment_method,
    description: p.description || "EduOS purchase", ...returnUrls(p.id, viewOf(p)) }));
  const done = await tx(a, async c => {
    const cur = await one(c, "SELECT * FROM commerce_payments WHERE id=$1 FOR UPDATE", [p.id]);
    if (cur.status !== "creating") return cur; // finished by a retry, or its hold ran out meanwhile
    if (!r.ok) {
      const code = r.error instanceof ProviderError ? r.error.code : "provider_error";
      await c.query("UPDATE commerce_payments SET status='declined', decline_code='provider_unavailable', confirmed_at=now(), pending_since=NULL, pending_actor=NULL WHERE id=$1", [p.id]);
      await releaseHold(c, cur);
      await audit(c, req, "checkout_failed", "commerce_payment", p.id, `provider=${p.provider};code=${code}${auditNote(req)}`, "failure");
      return null;
    }
    const ok = await one(c, `UPDATE commerce_payments SET status='requires_confirmation', provider_ref=$2, checkout_url=$3, pending_since=NULL, pending_actor=NULL
        WHERE id=$1 RETURNING *`, [p.id, r.value.providerRef, r.value.redirectUrl || null]);
    if (p.purpose === "event_tickets") await c.query("UPDATE event_ticket_orders SET provider_reference=$2 WHERE id=$1", [p.ticket_order_id, r.value.providerRef]);
    if (req.reconciled) await audit(c, req, "checkout_reconciled", "commerce_payment", p.id, `provider=${p.provider};reconciled=true`);
    return ok;
  });
  if (!done) throw asHttp(r.error, p.provider);
  return done;
}
async function createdPayment(req, paymentId, given) {
  const p = await finishCreate(req, paymentId, given);
  if (p.status === "expired" || p.status === "declined") throw new HttpError(409, "checkout_expired", { reason: "The hold ran out before the processor answered. Start again to buy." });
  return p;
}

// ---------------- tickets ----------------

/** Called by POST /api/events/:id/tickets for a priced ticket type (inside its transaction). */
export async function startTicketCheckout(c, req, { event, type, quantity, key }) {
  const a = req.actor;
  if (a.role !== "parent") throw new HttpError(403, "guardian_payment_required", { reason: "Only a parent or guardian can pay. Students can't make purchases." });
  const st = await commerceStatus(c, a.districtId), wanted = methodOf(req.body);
  if (!st.raw.enabled || (!st.enabled && wanted === undefined)) throw new HttpError(503, "paid_ticketing_not_configured", { checkoutEnabled: false, reason: disabledReason(st) });
  const { adapter, method, processor, mode } = await resolveCheckout(c, a.districtId, wanted);
  await c.query("SELECT eduos_commerce_expire_holds()");
  const t = await one(c, "SELECT * FROM event_ticket_types WHERE id=$1 AND district_id=$2 FOR UPDATE", [type.id, a.districtId]);
  if (!t.sales_open) throw new HttpError(404, "ticket_type_not_available");
  if (t.sold_count + quantity > t.capacity) throw new HttpError(409, "ticket_capacity_exceeded");
  const total = t.price_cents * quantity, fee = adapter.feeFor(total);
  feesGuard(() => ticketSettlement({ grossCents: total, processingFeeCents: fee, ...rates(st.raw), schoolId: event.school_id }));
  // A hosted page (PayPal, Square, BTCPay) takes longer than the sandbox.
  const holdMinutes = processor === "sandbox" ? st.raw.hold_minutes : Math.max(st.raw.hold_minutes, 20);
  await c.query("UPDATE event_ticket_types SET sold_count=sold_count+$2 WHERE id=$1", [t.id, quantity]);
  const order = await one(c, `INSERT INTO event_ticket_orders(district_id,school_id,event_id,buyer_user_id,ticket_type_id,quantity,total_cents,currency,status,idempotency_key,hold_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'payment_pending',$9, now() + make_interval(mins => $10)) RETURNING id,status,total_cents,currency,hold_expires_at`,
    [a.districtId, event.school_id, event.id, a.userId, t.id, quantity, total, t.currency, key, holdMinutes]);
  // Reserve: the seats and a 'creating' payment commit before the processor is called.
  const p = await one(c, `INSERT INTO commerce_payments(id,district_id,school_id,purpose,ticket_order_id,payer_user_id,amount_cents,currency,processing_fee_cents,provider,payment_method,mode,
        status,description,pending_since,pending_actor)
      VALUES($1,$2,$3,'event_tickets',$4,$5,$6,$7,$8,$9,$10,$11,'creating',$12,now(),$13::jsonb) RETURNING id`,
    [randomUUID(), a.districtId, event.school_id, order.id, a.userId, total, t.currency, fee, processor, method, mode,
      `${quantity} × ${t.name}, ${event.title}`.slice(0, 255), actorJson(a)]);
  await audit(c, req, "checkout", "event_ticket_order", order.id, `event=${event.id};quantity=${quantity};payment=${p.id};provider=${processor};method=${method};mode=${mode}`);
  return afterCommit(async () => {
    const paid = await createdPayment(req, p.id, adapter);
    return { order, tickets: [], replayed: false, payment: paymentOut(paid, { holdExpiresAt: order.hold_expires_at }) };
  });
}
/** Idempotent replay of a checkout that is still waiting for payment (finishes the create if it was cut off). */
export async function replayTicketCheckout(c, req, prior) {
  const base = { order: { id: prior.id, status: prior.status, total_cents: prior.total_cents, currency: prior.currency }, replayed: true, tickets: [] };
  const p = await one(c, "SELECT * FROM commerce_payments WHERE ticket_order_id=$1 ORDER BY created_at DESC LIMIT 1", [prior.id]);
  const holdExpiresAt = (await one(c, "SELECT hold_expires_at FROM event_ticket_orders WHERE id=$1", [prior.id]))?.hold_expires_at || null;
  if (p?.status === "creating") return afterCommit(async () => ({ ...base, payment: paymentOut(await createdPayment(req, p.id), { holdExpiresAt }) }));
  return { ...base, payment: p ? paymentOut(p, { holdExpiresAt }) : null };
}
/** Kept for callers of 37.7.0: the payment a pending order is waiting on. */
export async function pendingCheckout(c, orderId) {
  const p = await one(c, "SELECT * FROM commerce_payments WHERE ticket_order_id=$1 ORDER BY created_at DESC LIMIT 1", [orderId]);
  const o = await one(c, "SELECT hold_expires_at FROM event_ticket_orders WHERE id=$1", [orderId]);
  return p ? paymentOut(p, { holdExpiresAt: o?.hold_expires_at || null }) : null;
}

/** Record a ticket payment's outcome (phase 2 of confirm; the order is locked here). */
async function recordTickets(c, req, p, result) {
  const a = req.actor;
  const o = await one(c, `SELECT o.*, o.hold_expires_at < now() AS hold_expired, e.title AS event_title, t.name AS type_name
      FROM event_ticket_orders o JOIN school_events e ON e.id=o.event_id JOIN event_ticket_types t ON t.id=o.ticket_type_id WHERE o.id=$1 FOR UPDATE OF o`, [p.ticket_order_id]);
  if (!o || o.status !== "payment_pending") throw new HttpError(409, "order_not_awaiting_payment", { status: o?.status });
  if (result.status === "pending") {
    await c.query("UPDATE commerce_payments SET pending_since=NULL, pending_actor=NULL WHERE id=$1", [p.id]);
    return { status: "pending", payment: paymentOut(p, { holdExpiresAt: o.hold_expires_at }) };
  }
  if (result.status !== "succeeded") {
    await c.query("UPDATE commerce_payments SET status='declined', decline_code=$2, confirmed_at=now(), pending_since=NULL, pending_actor=NULL WHERE id=$1", [p.id, result.declineCode || "declined"]);
    await c.query("UPDATE event_ticket_orders SET status='cancelled' WHERE id=$1", [o.id]);
    await c.query("UPDATE event_ticket_types SET sold_count=greatest(sold_count-$2,0) WHERE id=$1", [o.ticket_type_id, o.quantity]);
    await audit(c, req, "payment_declined", "commerce_payment", p.id, `order=${o.id};code=${result.declineCode || "declined"}${auditNote(req)}`);
    return { status: "declined", declineCode: result.declineCode || "declined" };
  }
  const paid = await one(c, "UPDATE commerce_payments SET status='succeeded', confirmed_at=now(), provider_capture_ref=$2, pending_since=NULL, pending_actor=NULL WHERE id=$1 RETURNING *", [p.id, result.captureRef || null]);
  await c.query("UPDATE event_ticket_orders SET status='paid', paid_at=now() WHERE id=$1", [o.id]);
  const tickets = [];
  for (let i = 0; i < o.quantity; i++) {
    const { code, hash } = newCode();
    const t = await one(c, "INSERT INTO event_tickets(district_id,school_id,order_id,event_id,ticket_code_hash) VALUES($1,$2,$3,$4,$5) RETURNING id,status",
      [a.districtId, o.school_id, o.id, o.event_id, hash]);
    tickets.push({ id: t.id, status: t.status, code, qr: qrRows(code) });
  }
  const s = await loadSettings(c, a.districtId);
  const lines = ticketSettlement({ grossCents: paid.amount_cents, processingFeeCents: paid.processing_fee_cents, ...rates(s), schoolId: o.school_id });
  const receipt = await record(c, a, paid, "settlement", lines, `${o.quantity} × ${o.type_name}, ${o.event_title}`);
  await audit(c, req, "payment_succeeded", "commerce_payment", p.id, `order=${o.id};receipt=${receipt.number};edal=${receipt.edal.seq}${auditNote(req)}`);
  return { status: "succeeded", payment: paymentOut(paid), order: { id: o.id, status: "paid" }, tickets, receipt,
    note: "Ticket codes are shown once. EduOS keeps only a fingerprint of each code." };
}
const EXPIRED_REASON = paidAfterHold => (paidAfterHold
  ? "The payment arrived after the seats were released. The school will refund it; contact the school office."
  : "The seats were held for a few minutes and have been released. Start again to buy.");

// ---------------- marketplace ----------------

export async function startMarketplaceCheckout(c, req, feeEventId, b) {
  const a = req.actor, key = b?.idempotencyKey;
  if (typeof key !== "string" || key.length < 16 || key.length > 120) throw new HttpError(400, "invalid_idempotency_key");
  const st = await commerceStatus(c, a.districtId), wanted = methodOf(b);
  if (!st.raw.enabled || (!st.enabled && wanted === undefined)) throw new HttpError(503, "commerce_not_enabled", { reason: disabledReason(st) });
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [a.districtId, "mkt:" + feeEventId]);
  const prior = await one(c, "SELECT * FROM marketplace_purchases WHERE created_by=$1 AND idempotency_key=$2", [a.userId, key]);
  if (prior) {
    if (prior.fee_event_id !== feeEventId) throw new HttpError(409, "idempotency_key_reused");
    const pp = await one(c, "SELECT * FROM commerce_payments WHERE marketplace_purchase_id=$1 ORDER BY created_at DESC LIMIT 1", [prior.id]);
    if (pp?.status === "creating") return afterCommit(async () => ({ purchase: purchaseOut(prior), payment: paymentOut(await createdPayment(req, pp.id)), replayed: true }));
    return { purchase: purchaseOut(prior), payment: pp ? paymentOut(pp) : null, replayed: true };
  }
  const fe = await one(c, `SELECT f.id, f.listing_id, f.license_id, l.vendor_id, l.name, l.unit_price_cents, l.price_unit, lic.seat_limit, lic.status AS license_status
      FROM marketplace_fee_events f JOIN marketplace_listings l ON l.id=f.listing_id LEFT JOIN app_licenses lic ON lic.id=f.license_id WHERE f.id=$1`, [feeEventId]);
  if (!fe) throw new HttpError(404, "fee_event_not_found");
  if (!fe.unit_price_cents) throw new HttpError(409, "listing_not_priced");
  if (fe.license_status && fe.license_status !== "active") throw new HttpError(409, "license_not_active");
  if (await one(c, "SELECT id FROM marketplace_purchases WHERE fee_event_id=$1 AND status IN ('payment_pending','paid')", [fe.id]))
    throw new HttpError(409, "already_purchased");
  let qty = 1;
  if (fe.price_unit === "seat") {
    qty = fe.seat_limit ?? b?.quantity;
    if (!Number.isInteger(qty) || qty < 1 || qty > 100000) throw new HttpError(400, "invalid_quantity", { reason: "This license has no seat limit; say how many seats to pay for." });
  }
  const total = qty * fe.unit_price_cents;
  if (total > 100_000_000) throw new HttpError(400, "amount_too_large");
  const { adapter, method, processor, mode } = await resolveCheckout(c, a.districtId, wanted);
  const fee = adapter.feeFor(total);
  feesGuard(() => marketplaceSettlement({ grossCents: total, processingFeeCents: fee, marketplaceFeeBps: st.raw.marketplace_fee_bps, vendorId: fe.vendor_id }));
  const m = await one(c, `INSERT INTO marketplace_purchases(district_id,fee_event_id,listing_id,vendor_id,license_id,quantity,unit_price_cents,total_cents,idempotency_key,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [a.districtId, fe.id, fe.listing_id, fe.vendor_id, fe.license_id, qty, fe.unit_price_cents, total, key, a.userId]);
  const p = await one(c, `INSERT INTO commerce_payments(id,district_id,school_id,purpose,marketplace_purchase_id,payer_user_id,amount_cents,currency,processing_fee_cents,provider,payment_method,mode,
        status,description,pending_since,pending_actor)
      VALUES($1,$2,NULL,'marketplace_license',$3,$4,$5,'USD',$6,$7,$8,$9,'creating',$10,now(),$11::jsonb) RETURNING id`,
    [randomUUID(), a.districtId, m.id, a.userId, total, fee, processor, method, mode, `${qty === 1 ? "License" : `${qty} seats`}: ${fe.name}`.slice(0, 255), actorJson(a)]);
  await audit(c, req, "checkout", "marketplace_purchase", m.id, `fee_event=${fe.id};listing=${fe.listing_id};seats=${qty};payment=${p.id};provider=${processor};method=${method};mode=${mode}`);
  return afterCommit(async () => ({ purchase: purchaseOut(m), payment: paymentOut(await createdPayment(req, p.id, adapter)), replayed: false }));
}
const purchaseOut = m => ({ id: m.id, feeEventId: m.fee_event_id, listingId: m.listing_id, licenseId: m.license_id, quantity: m.quantity,
  unitPriceCents: m.unit_price_cents, totalCents: m.total_cents, currency: m.currency, status: m.status, createdAt: m.created_at });

async function recordMarketplace(c, req, p, result) {
  const a = req.actor;
  const m = await one(c, `SELECT m.*, l.name FROM marketplace_purchases m JOIN marketplace_listings l ON l.id=m.listing_id WHERE m.id=$1 FOR UPDATE OF m`, [p.marketplace_purchase_id]);
  if (!m || m.status !== "payment_pending") throw new HttpError(409, "purchase_not_awaiting_payment", { status: m?.status });
  if (result.status === "pending") {
    await c.query("UPDATE commerce_payments SET pending_since=NULL, pending_actor=NULL WHERE id=$1", [p.id]);
    return { status: "pending", payment: paymentOut(p) };
  }
  if (result.status !== "succeeded") {
    await c.query("UPDATE commerce_payments SET status='declined', decline_code=$2, confirmed_at=now(), pending_since=NULL, pending_actor=NULL WHERE id=$1", [p.id, result.declineCode || "declined"]);
    await c.query("UPDATE marketplace_purchases SET status='cancelled' WHERE id=$1", [m.id]);
    await audit(c, req, "payment_declined", "commerce_payment", p.id, `purchase=${m.id};code=${result.declineCode || "declined"}${auditNote(req)}`);
    return { status: "declined", declineCode: result.declineCode || "declined" };
  }
  const paid = await one(c, "UPDATE commerce_payments SET status='succeeded', confirmed_at=now(), provider_capture_ref=$2, pending_since=NULL, pending_actor=NULL WHERE id=$1 RETURNING *", [p.id, result.captureRef || null]);
  await c.query("UPDATE marketplace_purchases SET status='paid', paid_at=now() WHERE id=$1", [m.id]);
  const s = await loadSettings(c, a.districtId);
  const lines = marketplaceSettlement({ grossCents: paid.amount_cents, processingFeeCents: paid.processing_fee_cents, marketplaceFeeBps: s.marketplace_fee_bps, vendorId: m.vendor_id });
  const receipt = await record(c, a, paid, "settlement", lines, `${m.quantity === 1 ? "License" : `${m.quantity} seats`}: ${m.name}`);
  await audit(c, req, "payment_succeeded", "commerce_payment", p.id, `purchase=${m.id};receipt=${receipt.number};edal=${receipt.edal.seq}${auditNote(req)}`);
  return { status: "succeeded", payment: paymentOut(paid), purchase: { id: m.id, status: "paid" }, receipt };
}

// ---------------- confirm ----------------

/** Ask the payment's own processor where it stands (sandbox: the chosen test outcome). No transaction is open here. */
function providerConfirm(adapter, p, testOutcome) {
  const opts = p.provider === "sandbox" ? { testOutcome: testOutcome ?? "sandbox_success" } : { amountCents: p.amount_cents, currency: p.currency };
  return adapter.confirmPayment(p.provider_ref, opts);
}

/**
 * Phase 1 of confirm, inside the request's transaction: check the payment,
 * mark it in flight (pending_since/pending_actor), and stretch the seat hold
 * so the reconcile sweep or the hold timer can't release seats under a capture
 * that's under way. Returns the continuation that calls the processor.
 */
export async function confirmPayment(c, req, paymentId, testOutcome) {
  const a = req.actor;
  const p = await one(c, "SELECT * FROM commerce_payments WHERE id=$1 FOR UPDATE", [paymentId]);
  if (!p || p.payer_user_id !== a.userId) throw new HttpError(404, "payment_not_found");
  if (p.status !== "requires_confirmation") throw new HttpError(409, "payment_not_confirmable", { status: p.status });
  if (!(await loadSettings(c, a.districtId)).enabled) throw new HttpError(503, "commerce_not_enabled");
  const { adapter } = await adapterFor(c, a.districtId, p.provider, { forCheckout: false });
  if (p.purpose === "event_tickets") {
    const o = await one(c, "SELECT id, status, hold_expires_at < now() AS hold_expired FROM event_ticket_orders WHERE id=$1 FOR UPDATE", [p.ticket_order_id]);
    if (!o || o.status !== "payment_pending") throw new HttpError(409, "order_not_awaiting_payment", { status: o?.status });
    if (o.hold_expired) {
      // The seats go back now. Square and BTCPay take the money on their own
      // page; if it arrived after the hold ran out, say so (the school refunds
      // it in that processor's dashboard). PayPal is never captured after expiry.
      await c.query("SELECT eduos_commerce_expire_holds()");
      if (p.provider !== "square" && p.provider !== "btcpay") {
        await audit(c, req, "hold_expired", "commerce_payment", p.id, `order=${o.id}`);
        return { status: "expired", paidAfterHold: false, reason: EXPIRED_REASON(false) };
      }
      return afterCommit(async () => {
        const r = await outside(() => providerConfirm(adapter, p));
        const paidAfterHold = r.ok && r.value.status === "succeeded";
        await tx(a, c2 => audit(c2, req, "hold_expired", "commerce_payment", p.id, `order=${o.id}${paidAfterHold ? ";paid_after_hold=true" : ""}`, paidAfterHold ? "failure" : "success"));
        return { status: "expired", paidAfterHold, reason: EXPIRED_REASON(paidAfterHold) };
      });
    }
    await c.query("UPDATE event_ticket_orders SET hold_expires_at=greatest(hold_expires_at, now() + interval '5 minutes') WHERE id=$1", [o.id]);
  } else {
    const m = await one(c, "SELECT id, status FROM marketplace_purchases WHERE id=$1 FOR UPDATE", [p.marketplace_purchase_id]);
    if (!m || m.status !== "payment_pending") throw new HttpError(409, "purchase_not_awaiting_payment", { status: m?.status });
  }
  await c.query("UPDATE commerce_payments SET pending_since=now(), pending_actor=$2::jsonb WHERE id=$1", [p.id, actorJson(a)]);
  return afterCommit(() => finishConfirm(req, p.id, testOutcome, adapter));
}

/** Phase 2 of confirm: the processor call (no transaction open), then the record in a new transaction. */
export async function finishConfirm(req, paymentId, testOutcome, given = null) {
  const a = req.actor;
  const p = await tx(a, c => one(c, "SELECT * FROM commerce_payments WHERE id=$1", [paymentId]));
  if (!p) throw new HttpError(404, "payment_not_found");
  if (p.status !== "requires_confirmation") throw new HttpError(409, "payment_not_confirmable", { status: p.status });
  const adapter = await adapterOf(a, p, given);
  // A sandbox outcome is the payer's choice; the sweep never guesses one.
  const r = req.reconciled && p.provider === "sandbox" ? { ok: true, value: { status: "pending" } } : await outside(() => providerConfirm(adapter, p, testOutcome));
  const out = await tx(a, async c => {
    const cur = await one(c, "SELECT * FROM commerce_payments WHERE id=$1 FOR UPDATE", [p.id]);
    if (cur.status === "expired" && r.ok && r.value.status === "succeeded") {
      // The hold ran out while the processor was capturing.
      await audit(c, req, "hold_expired", "commerce_payment", p.id, `order=${p.ticket_order_id || p.marketplace_purchase_id};paid_after_hold=true${auditNote(req)}`, "failure");
      return { status: "expired", paidAfterHold: true, reason: EXPIRED_REASON(true) };
    }
    if (cur.status !== "requires_confirmation") throw new HttpError(409, "payment_not_confirmable", { status: cur.status });
    if (!r.ok) {
      await c.query("UPDATE commerce_payments SET pending_since=NULL, pending_actor=NULL WHERE id=$1", [p.id]);
      return null;
    }
    return cur.purpose === "event_tickets" ? recordTickets(c, req, cur, r.value) : recordMarketplace(c, req, cur, r.value);
  });
  if (!out) throw asHttp(r.error, p.provider);
  return out;
}

// ---------------- refund ----------------

const LINE_ORDER = ["gross", "processing_fee", "sales_tax", "network_fee", "school_share", "district_share", "state_share", "marketplace_fee", "vendor_payable"];
/**
 * Phase 1 of a refund, inside the request's transaction: check it's
 * refundable, then mark the payment refund_pending and the ticket order
 * refund_pending (gate check-in refuses its tickets meanwhile).
 */
export async function refundPayment(c, req, paymentId) {
  const a = req.actor;
  const p = await one(c, "SELECT * FROM commerce_payments WHERE id=$1 FOR UPDATE", [paymentId]);
  // Leaders only, and a principal only for their own school's ticket sales.
  const allowed = p && (a.role === "superintendent" || (a.role === "principal" && p.purpose === "event_tickets" && p.school_id === a.schoolId));
  if (!allowed) throw new HttpError(404, "payment_not_found");
  if (p.status !== "succeeded") throw new HttpError(409, "payment_not_refundable", { status: p.status });
  const { adapter } = await adapterFor(c, a.districtId, p.provider, { forCheckout: false });
  if (p.purpose === "event_tickets") {
    const o = await one(c, "SELECT id FROM event_ticket_orders WHERE id=$1 FOR UPDATE", [p.ticket_order_id]);
    const used = await one(c, "SELECT count(*)::int AS n FROM event_tickets WHERE order_id=$1 AND status='checked_in'", [o.id]);
    if (used.n > 0) throw new HttpError(409, "ticket_already_used", { reason: "A ticket on this order was already scanned at the gate." });
    await c.query("UPDATE event_ticket_orders SET refund_pending=true WHERE id=$1", [o.id]);
  }
  await c.query("UPDATE commerce_payments SET status='refund_pending', pending_since=now(), pending_actor=$2::jsonb WHERE id=$1", [p.id, actorJson(a)]);
  return afterCommit(() => finishRefund(req, p.id, adapter));
}

/** Phase 2 of a refund: the processor refund (keyed by the capture, so a retry can't refund twice), then the books. */
export async function finishRefund(req, paymentId, given = null) {
  const a = req.actor;
  const p = await tx(a, c => one(c, "SELECT * FROM commerce_payments WHERE id=$1", [paymentId]));
  if (!p) throw new HttpError(404, "payment_not_found");
  if (p.status !== "refund_pending") throw new HttpError(409, "payment_not_refundable", { status: p.status });
  const adapter = await adapterOf(a, p, given);
  const r = await outside(() => adapter.refundPayment(p.provider_ref, p.amount_cents, { captureRef: p.provider_capture_ref }));
  const out = await tx(a, async c => {
    const cur = await one(c, "SELECT * FROM commerce_payments WHERE id=$1 FOR UPDATE", [p.id]);
    if (cur.status !== "refund_pending") throw new HttpError(409, "payment_not_refundable", { status: cur.status });
    if (!r.ok) {
      // The processor refused or couldn't be reached: back to paid, tickets usable again.
      await c.query("UPDATE commerce_payments SET status='succeeded', pending_since=NULL, pending_actor=NULL WHERE id=$1", [p.id]);
      if (p.purpose === "event_tickets") await c.query("UPDATE event_ticket_orders SET refund_pending=false WHERE id=$1", [p.ticket_order_id]);
      await audit(c, req, "refund_failed", "commerce_payment", p.id, `provider=${p.provider};code=${r.error instanceof ProviderError ? r.error.code : "provider_error"}${auditNote(req)}`, "failure");
      return null;
    }
    let description = "Refund";
    if (p.purpose === "event_tickets") {
      const o = await one(c, `SELECT o.*, e.title FROM event_ticket_orders o JOIN school_events e ON e.id=o.event_id WHERE o.id=$1 FOR UPDATE OF o`, [p.ticket_order_id]);
      await c.query("UPDATE event_tickets SET status='refunded' WHERE order_id=$1 AND status='issued'", [o.id]);
      await c.query("UPDATE event_ticket_orders SET status='refunded', refunded_at=now(), refund_pending=false WHERE id=$1", [o.id]);
      await c.query("UPDATE event_ticket_types SET sold_count=greatest(sold_count-$2,0) WHERE id=$1", [o.ticket_type_id, o.quantity]);
      description = `Refund: ${o.quantity} ticket${o.quantity === 1 ? "" : "s"}, ${o.title}`;
    } else {
      const m = await one(c, `SELECT m.*, l.name FROM marketplace_purchases m JOIN marketplace_listings l ON l.id=m.listing_id WHERE m.id=$1 FOR UPDATE OF m`, [p.marketplace_purchase_id]);
      await c.query("UPDATE marketplace_purchases SET status='refunded', refunded_at=now() WHERE id=$1", [m.id]);
      description = `Refund: ${m.name}`;
    }
    const refunded = await one(c, "UPDATE commerce_payments SET status='refunded', refund_ref=$2, refunded_at=now(), pending_since=NULL, pending_actor=NULL WHERE id=$1 RETURNING *", [p.id, r.value.refundRef]);
    const settled = await rows(c, "SELECT line, recipient, recipient_id, amount_cents FROM commerce_ledger_entries WHERE payment_id=$1 AND entry_kind='settlement'", [p.id]);
    if (!settled.length) throw new HttpError(409, "payment_not_settled");
    settled.sort((x, y) => LINE_ORDER.indexOf(x.line) - LINE_ORDER.indexOf(y.line));
    const lines = settled.map(l => ({ line: l.line, recipient: l.recipient, recipientId: l.recipient_id || undefined, amount: -Number(l.amount_cents) }));
    const receipt = await record(c, a, refunded, "refund", lines, description);
    await audit(c, req, "refund", "commerce_payment", p.id, `receipt=${receipt.number};edal=${receipt.edal.seq};provider=${p.provider}${r.value.manual ? ";manual=true" : ""}${auditNote(req)}`);
    return { status: "refunded", payment: paymentOut(refunded), receipt, manual: Boolean(r.value.manual),
      note: r.value.manual ? "Recorded. Bitcoin refunds are paid in dollars by the district, outside EduOS." : undefined };
  });
  if (!out) throw asHttp(r.error, p.provider);
  return out;
}

// ---------------- reconcile ----------------

/**
 * Finish processor calls cut off midway (the API stopped between reserving
 * and recording). For every active district, lists payments in flight for
 * longer than staleSeconds through eduos_commerce_stale_payments() (district
 * context only), then repeats the same idempotent call as the user who
 * started it and records the answer. Safe to run on several instances.
 */
export async function reconcileCommercePayments({ db = pool, staleSeconds = config.commerceReconcileStaleSeconds, log = console } = {}) {
  const districts = (await db.query("SELECT id FROM districts WHERE status='active' ORDER BY id")).rows;
  const done = { resumed: 0, failed: 0 };
  for (const { id } of districts) {
    const client = await db.connect();
    let stale = [];
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.district_id',$1,true)", [id]);
      await client.query("SELECT eduos_commerce_expire_holds()");
      stale = (await client.query("SELECT payment_id, status, pending_actor FROM eduos_commerce_stale_payments($1)", [staleSeconds])).rows;
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      log.error?.("Commerce reconcile failed", { district: id, message: e.message });
      continue;
    } finally { client.release(); }
    for (const s of stale) {
      const pa = s.pending_actor || {};
      const req = { actor: { districtId: id, userId: pa.userId, role: pa.role, schoolId: pa.schoolId || null }, requestId: `reconcile-${randomUUID()}`, reconciled: true };
      const step = s.status === "creating" ? () => finishCreate(req, s.payment_id)
        : s.status === "refund_pending" ? () => finishRefund(req, s.payment_id)
          : () => finishConfirm(req, s.payment_id);
      try { await step(); done.resumed++; }
      catch (e) { done.failed++; log.error?.("Commerce reconcile step failed", { payment: s.payment_id, status: s.status, code: e.code || e.message }); }
    }
  }
  return done;
}

export const money = formatCents;
