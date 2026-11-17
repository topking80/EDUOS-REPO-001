// 37.9.0: private media pipeline contract. No provider ships enabled by default.
// Storage adapters must implement private, tenant-scoped object operations;
// scanners must return an explicit clean verdict. Missing adapters fail closed.
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

/**
 * Adapter contract:
 * storage.createPrivateUpload({assetId,districtId,schoolId,mimeType,byteSize})
 *   -> { uploadUrl, storageKey, expiresAt } (private, single-object, short-lived)
 * storage.headPrivateObject({storageKey}) -> { byteSize, mimeType, checksum }
 * storage.createPrivateReadUrl({storageKey,expiresInSeconds}) -> {url,expiresAt}
 * scanner.scanPrivateObject({storageKey,mimeType,byteSize}) -> {verdict:"clean"|"blocked",reason?}
 * processor.processImage({storageKey,mimeType}) -> {storageKey, mimeType, byteSize, checksum}
 *
 * The caller supplies trusted tenant IDs and never supplies a storage key or URL.
 */
export function createMediaPipeline({ storage = null, scanner = null, processor = null } = {}) {
  const configured = has(storage, "createPrivateUpload") && has(storage, "headPrivateObject") &&
    has(storage, "createPrivateReadUrl") && has(scanner, "scanPrivateObject") && has(processor, "processImage");
  const requireReady = () => { if (!configured) throw new MediaPipelineError("private_media_pipeline_not_configured"); };
  return Object.freeze({
    enabled: configured,
    async beginUpload({ districtId, schoolId, input }) {
      requireReady();
      if (!districtId || !schoolId) throw new MediaPipelineError("media_tenant_scope_required", 400);
      const intent = validateMediaIntent(input);
      const result = await storage.createPrivateUpload({
        assetId: intent.id, districtId, schoolId, mimeType: intent.mimeType, byteSize: intent.byteSize
      });
      if (!result || typeof result.uploadUrl !== "string" || typeof result.storageKey !== "string" ||
          !result.storageKey || !Number.isFinite(Date.parse(result.expiresAt)))
        throw new MediaPipelineError("invalid_private_storage_response");
      return { assetId: intent.id, kind: intent.kind, mimeType: intent.mimeType, byteSize: intent.byteSize,
        uploadUrl: result.uploadUrl, expiresAt: result.expiresAt, storageKey: result.storageKey };
    },
    async verifyUploadedObject({ storageKey, expected }) {
      requireReady();
      if (typeof storageKey !== "string" || !storageKey || !expected?.id)
        throw new MediaPipelineError("invalid_uploaded_media_reference", 400);
      const object = await storage.headPrivateObject({ storageKey });
      if (!object || object.byteSize !== expected.byteSize || object.mimeType !== expected.mimeType)
        throw new MediaPipelineError("uploaded_object_mismatch", 422);
      const scan = await scanner.scanPrivateObject({ storageKey, mimeType: expected.mimeType, byteSize: expected.byteSize });
      if (!scan || scan.verdict !== "clean") throw new MediaPipelineError("media_security_scan_blocked", 422);
      if (expected.kind === "image") {
        const processed = await processor.processImage({ storageKey, mimeType: expected.mimeType });
        if (!processed || !processed.storageKey || !Number.isSafeInteger(processed.byteSize) || processed.byteSize < 1)
          throw new MediaPipelineError("image_processing_failed", 422);
        return { ...processed, scanStatus: "clean", processingStatus: "processed" };
      }
      // Video delivery remains unavailable until a video transcode/sanitization adapter exists.
      throw new MediaPipelineError("video_processing_adapter_not_configured");
    },
    async createReadUrl({ storageKey, consentStatus, moderationStatus, scanStatus }) {
      requireReady();
      if (consentStatus !== "approved" || moderationStatus !== "approved" || scanStatus !== "clean")
        throw new MediaPipelineError("media_not_approved", 403);
      if (typeof storageKey !== "string" || !storageKey) throw new MediaPipelineError("invalid_media_reference", 400);
      const result = await storage.createPrivateReadUrl({ storageKey, expiresInSeconds: MEDIA_LIMITS.signedUrlSeconds });
      if (!result || typeof result.url !== "string" || !Number.isFinite(Date.parse(result.expiresAt)))
        throw new MediaPipelineError("invalid_private_storage_response");
      if (Date.parse(result.expiresAt) - Date.now() > MEDIA_LIMITS.signedUrlSeconds * 1000 + 5000)
        throw new MediaPipelineError("private_url_ttl_exceeded");
      return result;
    }
  });
}

export const mediaPipeline = createMediaPipeline();
