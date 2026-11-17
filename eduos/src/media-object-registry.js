// 37.9.4: durable tenant-scoped registry for private object-storage keys.
// Transaction access is injected so importing this module never creates a DB pool.
const DISTRICT_ROLES = new Set(["superintendent", "it_admin"]);

export function createPostgresMediaRegistry({ withTenantTransaction } = {}) {
  if (typeof withTenantTransaction !== "function") throw new TypeError("withTenantTransaction is required");
  const scoped = async (actor, districtId, schoolId, callback) => {
    if (!actor?.userId || !actor?.role || actor.districtId !== districtId || !districtId || !schoolId ||
        (!DISTRICT_ROLES.has(actor.role) && actor.schoolId !== schoolId)) {
      throw Object.assign(new Error("media_registry_scope_required"), { code: "media_registry_scope_required", status: 403 });
    }
    return withTenantTransaction(actor, callback);
  };
  return Object.freeze({
    async createPrivateObject({ actor, districtId, schoolId, assetId, storageKey, kind, mimeType, byteSize }) {
      if (!assetId || typeof storageKey !== "string" || !storageKey || !["image", "video"].includes(kind) ||
          typeof mimeType !== "string" || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > 52428800) {
        throw Object.assign(new Error("invalid_private_media_record"), { code: "invalid_private_media_record", status: 400 });
      }
      return scoped(actor, districtId, schoolId, async client => {
        await client.query(
          `INSERT INTO private_media_objects(asset_id,district_id,school_id,storage_key,media_kind,mime_type,byte_size)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [assetId,districtId,schoolId,storageKey,kind,mimeType,byteSize]
        );
      });
    },
    async getPrivateObject({ actor, districtId, schoolId, assetId }) {
      return scoped(actor, districtId, schoolId, async client => {
        const result = await client.query(
          `SELECT asset_id AS "assetId",district_id AS "districtId",school_id AS "schoolId",
                  storage_key AS "storageKey",media_kind AS kind,mime_type AS "mimeType",
                  byte_size AS "byteSize",scan_status AS "scanStatus",processing_status AS "processingStatus"
             FROM private_media_objects
            WHERE asset_id=$1 AND district_id=$2 AND school_id=$3
            LIMIT 1`,
          [assetId,districtId,schoolId]
        );
        const record = result.rows[0];
        if (!record) throw Object.assign(new Error("media_reference_not_found"), { code: "media_reference_not_found", status: 404 });
        return record;
      });
    },
    async updatePrivateObject({ actor, districtId, schoolId, assetId, storageKey, mimeType, byteSize, scanStatus, processingStatus }) {
      return scoped(actor, districtId, schoolId, async client => {
        const result = await client.query(
          `UPDATE private_media_objects
              SET storage_key=COALESCE($4,storage_key), mime_type=COALESCE($5,mime_type),
                  byte_size=COALESCE($6,byte_size), scan_status=COALESCE($7,scan_status),
                  processing_status=COALESCE($8,processing_status), updated_at=now()
            WHERE asset_id=$1 AND district_id=$2 AND school_id=$3
            RETURNING asset_id`,
          [assetId,districtId,schoolId,storageKey??null,mimeType??null,byteSize??null,scanStatus??null,processingStatus??null]
        );
        if (!result.rowCount) throw Object.assign(new Error("media_reference_not_found"), { code: "media_reference_not_found", status: 404 });
      });
    }
  });
}
