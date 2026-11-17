// 37.9.1: private media pipeline contract. No provider ships enabled by default.
// Storage object keys are retained only in this module's private, process-local registry.
// A durable tenant-scoped registry is required before multi-instance/production use.
import { randomUUID } from "node:crypto";

export const MEDIA_LIMITS = Object.freeze({
  imageBytes: 20 * 1024 * 1024,
  videoBytes: 50 * 1024 * 1024,
  signedUrlSeconds: 60,
  imageMimeTypes: Object.freeze(["image/jpeg", "image/png", "image/webp"]),
  videoMimeTypes: Object.freeze(["video/mp4", "video/webm", "video/quicktime"])
});

export class MediaPipelineError extends Error {
  constructor(code, status = 503) { super(code); this.name = "MediaPipelineError"; this.code = code; this.status = status; }
}

export function validateMediaIntent(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MediaPipelineError("invalid_media_intent", 400);
  const kind = input.kind;
  const mimeType = typeof input.mimeType === "string" ? input.mimeType.toLowerCase() : "";
  const allowed = kind === "image" ? MEDIA_LIMITS.imageMimeTypes : kind === "video" ? MEDIA_LIMITS.videoMimeTypes : [];
  const maxBytes = kind === "image" ? MEDIA_LIMITS.imageBytes : kind === "video" ? MEDIA_LIMITS.videoBytes : 0;
  if (!allowed.includes(mimeType)) throw new MediaPipelineError("unsupported_media_type", 415);
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > maxBytes)
    throw new MediaPipelineError("media_size_out_of_range", 413);
  return Object.freeze({ id: randomUUID(), kind, mimeType, byteSize: input.byteSize });
}

const has = (value, method) => Boolean(value && typeof value[method] === "function");

export function createMediaPipeline({ storage = null, scanner = null, processor = null, authorization = null } = {}) {
  const configured = has(storage, "createPrivateUpload") && has(storage, "headPrivateObject") &&
    has(storage, "createPrivateReadUrl") && has(scanner, "scanPrivateObject") && has(processor, "processImage") &&
    has(authorization, "withAuthorizedMediaDelivery");
  // Never return or accept storage keys at the public pipeline boundary.
  // The key map is intentionally private and fails closed after process restart.
  const privateObjects = new Map();
  const requireReady = () => { if (!configured) throw new MediaPipelineError("private_media_pipeline_not_configured"); };
  const getPrivateObject = ({ assetId, districtId, schoolId }) => {
    if (typeof assetId !== "string" || !assetId || !districtId || !schoolId)
      throw new MediaPipelineError("invalid_media_reference", 400);
    const record = privateObjects.get(assetId);
    if (!record || record.districtId !== districtId || record.schoolId !== schoolId)
      throw new MediaPipelineError("media_reference_not_found", 404);
    return record;
  };
  return Object.freeze({
    enabled: configured,
    async beginUpload({ districtId, schoolId, input }) {
      requireReady();
      if (!districtId || !schoolId) throw new MediaPipelineError("media_tenant_scope_required", 400);
      const intent = validateMediaIntent(input);
      const result = await storage.createPrivateUpload({
        assetId: intent.id, districtId, schoolId, mimeType: intent.mimeType, byteSize: intent.byteSize
      });
      const uploadExpiry = Date.parse(result?.expiresAt);
      let uploadUrl;
      try { uploadUrl = new URL(result?.uploadUrl); } catch { throw new MediaPipelineError("invalid_private_storage_response"); }
      if (!result || uploadUrl.protocol !== "https:" || !uploadUrl.hostname ||
          typeof result.storageKey !== "string" || !result.storageKey ||
          !Number.isFinite(uploadExpiry) || uploadExpiry <= Date.now() ||
          uploadExpiry - Date.now() > 5 * 60 * 1000)
        throw new MediaPipelineError("invalid_private_storage_response");
      privateObjects.set(intent.id, {
        districtId, schoolId, storageKey: result.storageKey,
        kind: intent.kind, mimeType: intent.mimeType, byteSize: intent.byteSize,
        scanStatus: "pending", processingStatus: "pending"
      });
      return Object.freeze({ assetId: intent.id, kind: intent.kind, mimeType: intent.mimeType,
        byteSize: intent.byteSize, uploadUrl: result.uploadUrl, expiresAt: result.expiresAt });
    },
    async verifyUploadedObject({ assetId, districtId, schoolId }) {
      requireReady();
      const record = getPrivateObject({ assetId, districtId, schoolId });
      const object = await storage.headPrivateObject({ storageKey: record.storageKey });
      if (!object || object.byteSize !== record.byteSize || object.mimeType !== record.mimeType)
        throw new MediaPipelineError("uploaded_object_mismatch", 422);
      const scan = await scanner.scanPrivateObject({
        storageKey: record.storageKey, mimeType: record.mimeType, byteSize: record.byteSize
      });
      if (!scan || scan.verdict !== "clean") throw new MediaPipelineError("media_security_scan_blocked", 422);
      if (record.kind === "image") {
        const processed = await processor.processImage({
          storageKey: record.storageKey, mimeType: record.mimeType,
          outputMimeTypes: MEDIA_LIMITS.imageMimeTypes, maxOutputBytes: MEDIA_LIMITS.imageBytes,
          stripMetadata: true, reencode: true
        });
        if (!processed || typeof processed.storageKey !== "string" || !processed.storageKey ||
            !MEDIA_LIMITS.imageMimeTypes.includes(processed.mimeType) ||
            !Number.isSafeInteger(processed.byteSize) || processed.byteSize < 1 ||
            processed.byteSize > MEDIA_LIMITS.imageBytes ||
            processed.metadataStripped !== true || processed.reencoded !== true)
          throw new MediaPipelineError("image_processing_failed", 422);
        record.storageKey = processed.storageKey;
        record.mimeType = processed.mimeType;
        record.byteSize = processed.byteSize;
        record.scanStatus = "clean";
        record.processingStatus = "processed";
        return Object.freeze({ assetId, mimeType: record.mimeType, byteSize: record.byteSize,
          scanStatus: record.scanStatus, processingStatus: record.processingStatus });
      }
      // Video delivery remains unavailable until a video transcode/sanitization adapter exists.
      throw new MediaPipelineError("video_processing_adapter_not_configured");
    },
    async createReadUrl({ assetId, districtId, schoolId, actor }) {
      requireReady();
      const record = getPrivateObject({ assetId, districtId, schoolId });
      if (record.scanStatus !== "clean" || record.processingStatus !== "processed")
        throw new MediaPipelineError("media_not_security_processed", 403);
      // The authorization adapter must hold DB row locks while checking the asset,
      // every participant, and every guardian decision, then invoke issueReadUrl.
      // Caller-supplied consent/moderation values are deliberately not accepted.
      return authorization.withAuthorizedMediaDelivery({
        actor, assetId, districtId, schoolId,
        issueReadUrl: async () => {
          const result = await storage.createPrivateReadUrl({
            storageKey: record.storageKey, expiresInSeconds: MEDIA_LIMITS.signedUrlSeconds
          });
          let readUrl;
          try { readUrl = new URL(result?.url); } catch { throw new MediaPipelineError("invalid_private_storage_response"); }
          const readExpiry = Date.parse(result?.expiresAt);
          if (readUrl.protocol !== "https:" || !readUrl.hostname || !Number.isFinite(readExpiry) ||
              readExpiry <= Date.now() || readExpiry - Date.now() > MEDIA_LIMITS.signedUrlSeconds * 1000 + 5000)
            throw new MediaPipelineError("private_url_ttl_exceeded");
          return Object.freeze({ url: result.url, expiresAt: result.expiresAt });
        }
      });
    }
  });
}

export const mediaPipeline = createMediaPipeline();
