import test from "node:test";
import assert from "node:assert/strict";
import { normalizeVerifiedPaymentEvent as normalize } from "../src/commerce/webhook-events.js";

test("PayPal: only completed capture events become settlement candidates", () => {
  const base = { id: "WH-EVENT-1234", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {
    id: "CAPTURE123", amount: { value: "12.34", currency_code: "USD" },
    supplementary_data: { related_ids: { order_id: "ORDER1234" } }
  } };
  assert.deepEqual(normalize("paypal", base), {
    processor: "paypal", providerEventId: "WH-EVENT-1234", eventType: "PAYMENT.CAPTURE.COMPLETED",
    disposition: "settle_candidate", providerRef: "ORDER1234", captureRef: "CAPTURE123", amountCents: 1234, currency: "USD"
  });
  assert.equal(normalize("paypal", { ...base, event_type: "CHECKOUT.ORDER.APPROVED" }).disposition, "ignored");
  assert.equal(normalize("paypal", { ...base, resource: { ...base.resource, amount: { value: "12.345", currency_code: "USD" } } }), null);
});

test("Square: completed payment uses its order reference and integer minor units", () => {
  const event = { event_id: "SQ-EVENT-1234", type: "payment.updated", data: { object: { payment: {
    id: "SQ-PAYMENT-123", order_id: "SQ-ORDER-1234", status: "COMPLETED",
    amount_money: { amount: 2500, currency: "USD" }
  } } } };
  assert.deepEqual(normalize("square", event), {
    processor: "square", providerEventId: "SQ-EVENT-1234", eventType: "payment.updated",
    disposition: "settle_candidate", providerRef: "SQ-ORDER-1234", captureRef: "SQ-PAYMENT-123",
    amountCents: 2500, currency: "USD"
  });
  const pending = structuredClone(event); pending.data.object.payment.status = "APPROVED";
  assert.equal(normalize("square", pending).disposition, "ignored");
  const invalid = structuredClone(event); invalid.data.object.payment.amount_money.amount = 25.5;
  assert.equal(normalize("square", invalid), null);
});

test("BTCPay: InvoiceSettled is actionable; other invoice states are ignored", () => {
  const event = { deliveryId: "BTCPAY-EVENT-123", type: "InvoiceSettled", invoiceId: "INV-12345", amount: "8.05", currency: "USD" };
  assert.deepEqual(normalize("btcpay", event), {
    processor: "btcpay", providerEventId: "BTCPAY-EVENT-123", eventType: "InvoiceSettled",
    disposition: "settle_candidate", providerRef: "INV-12345", captureRef: "INV-12345", amountCents: 805, currency: "USD"
  });
  assert.equal(normalize("btcpay", { ...event, type: "InvoiceProcessing" }).disposition, "ignored");
});

test("malformed identities, amounts, currencies and unknown processors fail closed", () => {
  assert.equal(normalize("paypal", { id: "x", event_type: "PAYMENT.CAPTURE.COMPLETED" }), null);
  assert.equal(normalize("square", { event_id: "SQ-EVENT-1234", type: "payment.updated" }), null);
  assert.equal(normalize("btcpay", { deliveryId: "BTCPAY-EVENT-123", type: "InvoiceSettled", invoiceId: "INV-12345", amount: "0", currency: "USD" }), null);
  assert.equal(normalize("other", { id: "EVENT-1234", type: "ok" }), null);
  assert.equal(normalize("paypal", null), null);
});
