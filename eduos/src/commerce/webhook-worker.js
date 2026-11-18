// EduOS 37.8.0: leased worker for verified payment-provider events.
import { randomUUID } from "node:crypto";
import { pool, withTenantTransaction } from "../db.js";
import { applyVerifiedWebhook } from "./service.js";
import { one } from "../role-app-util.js";

const safeCode = value => String(value || "webhook_processing_failed")
  .toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80) || "webhook_processing_failed";

/**
 * Claiming is performed by a narrow SECURITY DEFINER function. Settlement is
 * then executed under the original payer's saved tenant actor and in one
 * transaction with the inbox terminal state, reusing the normal commerce path.
 */
export async function processCommerceWebhookEvents({ db = pool, limit = 25, log = console } = {}) {
  const summary = { claimed: 0, applied: 0, ignored: 0, failed: 0 };
  for (let i = 0; i < Math.max(1, Math.min(100, limit)); i++) {
    const result = await db.query("SELECT eduos_commerce_claim_webhook() AS event");
    const event = result.rows[0]?.event;
    if (!event) break;
    summary.claimed++;
    const saved = event.payerActor;
    const actor = saved && {
      districtId: event.districtId,
      userId: saved.userId,
      role: saved.role,
      schoolId: saved.schoolId || null
    };
    if (!actor?.userId || !actor?.role) {
      summary.failed++;
      log.error?.("Commerce webhook claim has no valid payer actor", { event: event.id });
      continue;
    }
    const req = { actor, requestId: `webhook-${randomUUID()}`, reconciled: true };
    try {
      const outcome = await withTenantTransaction(actor, async c => {
        const current = await one(c, "SELECT * FROM commerce_webhook_events WHERE id=$1 FOR UPDATE", [event.id]);
        if (!current || current.state !== "processing" || current.attempts !== event.attempts)
          return { outcome: "ignored", reason: "claim_no_longer_current" };
        if (!current.provider_ref || current.provider_ref !== event.providerRef
            || current.provider_capture_ref !== event.captureRef
            || current.amount_cents !== event.amountCents || current.currency !== event.currency)
          throw Object.assign(new Error("webhook_event_integrity_mismatch"), { code: "webhook_event_integrity_mismatch" });
        const applied = await applyVerifiedWebhook(c, req, {
          paymentId: event.paymentId, processor: event.processor, providerRef: event.providerRef,
          captureRef: event.captureRef, amountCents: event.amountCents, currency: event.currency
        });
        const state = applied.outcome === "applied" ? "applied" : "ignored";
        await c.query("UPDATE commerce_webhook_events SET state=$2,last_error_code=$3 WHERE id=$1",
          [event.id, state, state === "ignored" ? safeCode(applied.reason) : null]);
        return applied;
      });
      if (outcome.outcome === "applied") summary.applied++;
      else summary.ignored++;
    } catch (error) {
      summary.failed++;
      const code = safeCode(error.code || error.message);
      try {
        await withTenantTransaction(actor, async c => {
          await c.query(`UPDATE commerce_webhook_events
              SET state='failed',last_error_code=$2
            WHERE id=$1 AND state='processing' AND attempts=$3`,
            [event.id, code, event.attempts]);
        });
      } catch (markError) {
        log.error?.("Commerce webhook failure state could not be recorded", {
          event: event.id, code: safeCode(markError.code || markError.message)
        });
      }
      log.error?.("Commerce webhook processing failed", { event: event.id, code });
    }
  }
  return summary;
}
