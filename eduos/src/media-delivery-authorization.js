// 37.9.2: PostgreSQL-backed authorization gate for private media delivery.
// The signed URL is minted while the asset, participant and guardian-consent rows
// remain locked in the same tenant-scoped transaction.
const LEAD_ROLES = new Set(["principal", "superintendent"]);

export function createPostgresMediaAuthorization({ withTenantTransaction } = {}) {
  if (typeof withTenantTransaction !== "function") throw new TypeError("withTenantTransaction is required");
  return Object.freeze({
    async withAuthorizedMediaDelivery({ actor, assetId, districtId, schoolId, issueReadUrl }) {
      if (!actor?.userId || !actor?.role || actor.districtId !== districtId ||
          !districtId || !schoolId || typeof issueReadUrl !== "function")
        throw Object.assign(new Error("media_authorization_scope_required"), { code: "media_authorization_scope_required", status: 403 });
      return withTenantTransaction(actor, async client => {
        const assetResult = await client.query(
          `SELECT id,school_id,activity_id,consent_status,moderation_status
             FROM activity_media_assets
            WHERE id=$1 AND district_id=$2 AND school_id=$3
            FOR UPDATE`,
          [assetId, districtId, schoolId]
        );
        const asset = assetResult.rows[0];
        if (!asset) throw Object.assign(new Error("media_asset_not_found"), { code: "media_asset_not_found", status: 404 });
        if (asset.consent_status !== "approved" || asset.moderation_status !== "approved")
          throw Object.assign(new Error("media_not_approved"), { code: "media_not_approved", status: 403 });
        if (!LEAD_ROLES.has(actor.role)) {
          if (actor.role !== "teacher" || !asset.activity_id) {
            throw Object.assign(new Error("media_delivery_forbidden"), { code: "media_delivery_forbidden", status: 403 });
          }
          const assigned = await client.query(
            `SELECT 1 FROM activity_staff
              WHERE district_id=$1 AND school_id=$2 AND activity_id=$3 AND user_id=$4
              LIMIT 1`,
            [districtId, schoolId, asset.activity_id, actor.userId]
          );
          if (!assigned.rowCount) throw Object.assign(new Error("media_delivery_forbidden"), { code: "media_delivery_forbidden", status: 403 });
        } else if (actor.role === "principal" && actor.schoolId !== schoolId) {
          throw Object.assign(new Error("media_school_scope_denied"), { code: "media_school_scope_denied", status: 403 });
        }

        const participants = await client.query(
          `SELECT student_id,consent_status
             FROM activity_media_participants
            WHERE district_id=$1 AND school_id=$2 AND media_asset_id=$3
            ORDER BY student_id
            FOR UPDATE`,
          [districtId, schoolId, assetId]
        );
        if (!participants.rowCount) throw Object.assign(new Error("media_participants_required"), { code: "media_participants_required", status: 403 });
        for (const participant of participants.rows) {
          const decisions = await client.query(
            `SELECT status FROM activity_media_consents
              WHERE district_id=$1 AND school_id=$2 AND media_asset_id=$3 AND student_id=$4
              ORDER BY guardian_user_id
              FOR UPDATE`,
            [districtId, schoolId, assetId, participant.student_id]
          );
          const statuses = decisions.rows.map(row => row.status);
          if (participant.consent_status !== "approved" || !statuses.includes("approved") ||
              statuses.some(status => status === "denied" || status === "withdrawn")) {
            throw Object.assign(new Error("media_not_approved"), { code: "media_not_approved", status: 403 });
          }
        }
        // Hold the locks until the short-lived URL has been minted.
        return issueReadUrl();
      });
    }
  });
}
