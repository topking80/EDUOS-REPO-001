// 37.9.4: compose media delivery with PostgreSQL-backed object metadata and authorization.
import { createMediaPipeline } from "./media-pipeline.js";
import { createPostgresMediaRegistry } from "./media-object-registry.js";
import { createPostgresMediaAuthorization } from "./media-delivery-authorization.js";

export function createPostgresBackedMediaPipeline({ withTenantTransaction, ...providers } = {}) {
  if (typeof withTenantTransaction !== "function") throw new TypeError("withTenantTransaction is required");
  const registry = createPostgresMediaRegistry({ withTenantTransaction });
  const authorization = createPostgresMediaAuthorization({ withTenantTransaction });
  return createMediaPipeline({ ...providers, registry, authorization });
}
