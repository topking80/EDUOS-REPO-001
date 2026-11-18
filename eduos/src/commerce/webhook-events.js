// 37.8.0: normalize provider notifications only after adapter signature verification.
// This module deliberately performs no I/O and never settles a payment.
const ID = /^[A-Za-z0-9_-]{4,128}$/;
const CURRENCY = /^[A-Z]{3}$/;

function cents(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const n = Math.round(value * 100);
    return Math.abs(value * 100 - n) < 1e-7 && n <= 100_000_000 ? n : null;
  }
  if (typeof value !== "string" || !/^\d{1,8}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const n = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(n) && n > 0 && n <= 100_000_000 ? n : null;
}
const id = value => typeof value === "string" && ID.test(value) ? value : null;
const money = (amount, currency) => {
  const amountCents = cents(amount);
  return amountCents && typeof currency === "string" && CURRENCY.test(currency)
    ? { amountCents, currency } : null;
};

/**
 * Normalize a cryptographically verified provider event.
 * Unsupported/non-final notifications are returned as ignored, never success.
 * The caller must still match providerRef, amount, currency and captureRef to a
 * pending commerce_payments row before invoking any settlement recorder.
 */
export function normalizeVerifiedPaymentEvent(processor, event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const providerEventId = id(event.id || event.event_id || event.deliveryId);
  const eventType = typeof (event.event_type || event.type) === "string"
    ? (event.event_type || event.type).slice(0, 120) : null;
  if (!providerEventId || !eventType) return null;

  if (processor === "paypal") {
    if (eventType !== "PAYMENT.CAPTURE.COMPLETED") return { processor, providerEventId, eventType, disposition: "ignored" };
    const capture = event.resource;
    const providerRef = id(capture?.supplementary_data?.related_ids?.order_id);
    const captureRef = id(capture?.id);
    const m = money(capture?.amount?.value, capture?.amount?.currency_code);
    if (!providerRef || !captureRef || !m) return null;
    return { processor, providerEventId, eventType, disposition: "settle_candidate", providerRef, captureRef, ...m };
  }

  if (processor === "square") {
    if (eventType !== "payment.updated") return { processor, providerEventId, eventType, disposition: "ignored" };
    const payment = event.data?.object?.payment;
    if (payment?.status !== "COMPLETED") return { processor, providerEventId, eventType, disposition: "ignored" };
    const providerRef = id(payment.order_id);
    const captureRef = id(payment.id);
    const m = money(payment.amount_money?.amount / 100, payment.amount_money?.currency);
    // Square's amount is integer cents; avoid floating-point interpretation.
    const amountCents = payment.amount_money?.amount;
    if (!providerRef || !captureRef || !Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 100_000_000
      || !CURRENCY.test(payment.amount_money?.currency || "")) return null;
    return { processor, providerEventId, eventType, disposition: "settle_candidate", providerRef, captureRef, amountCents, currency: payment.amount_money.currency };
  }

  if (processor === "btcpay") {
    if (eventType !== "InvoiceSettled") return { processor, providerEventId, eventType, disposition: "ignored" };
    const providerRef = id(event.invoiceId);
    const captureRef = providerRef;
    const m = money(event.amount, event.currency);
    if (!providerRef || !m) return null;
    return { processor, providerEventId, eventType, disposition: "settle_candidate", providerRef, captureRef, ...m };
  }
  return null;
}
