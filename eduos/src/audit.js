import { withTenantTransaction } from "./db.js";

export async function writeAudit(actor, event) {
  return withTenantTransaction(actor, async client => {
    await client.query(
      `INSERT INTO audit_events
        (district_id, actor_user_id, actor_role, action, resource_type, resource_id, outcome, detail, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [actor.districtId, actor.userId, actor.role, event.action,
       event.resourceType, event.resourceId || null, event.outcome || "success",
       event.detail || null, event.requestId || null]
    );
  });
}
