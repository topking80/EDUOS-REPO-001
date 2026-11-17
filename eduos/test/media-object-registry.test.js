import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresMediaRegistry } from "../src/media-object-registry.js";
import { createPostgresBackedMediaPipeline } from "../src/media-pipeline-postgres.js";

test("PostgreSQL media registry persists object keys through tenant transactions", async () => {
  const persisted = new Map();
  const statements = [];
  const withTenantTransaction = async (actor, fn) => fn({ query: async (sql, params) => {
    statements.push(sql);
    if (sql.includes("INSERT INTO private_media_objects")) {
      persisted.set(params[0], { assetId: params[0], districtId: params[1], schoolId: params[2], storageKey: params[3], kind: params[4], mimeType: params[5], byteSize: params[6], scanStatus: "pending", processingStatus: "pending" });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("FROM private_media_objects")) {
      const row = persisted.get(params[0]);
      return { rowCount: row && row.districtId === params[1] && row.schoolId === params[2] ? 1 : 0, rows: row && row.districtId === params[1] && row.schoolId === params[2] ? [row] : [] };
    }
    if (sql.includes("UPDATE private_media_objects")) {
      const row = persisted.get(params[0]);
      if (!row || row.districtId !== params[1] || row.schoolId !== params[2]) return { rowCount: 0, rows: [] };
      if (params[3] !== null) row.storageKey = params[3];
      if (params[4] !== null) row.mimeType = params[4];
      if (params[5] !== null) row.byteSize = params[5];
      if (params[6] !== null) row.scanStatus = params[6];
      if (params[7] !== null) row.processingStatus = params[7];
      return { rowCount: 1, rows: [{ asset_id: params[0] }] };
    }
    throw new Error("unexpected SQL");
  }});
  const actor = { userId: "principal", role: "principal", districtId: "district-a", schoolId: "school-a" };
  const registry = createPostgresMediaRegistry({ withTenantTransaction });
  await registry.createPrivateObject({ actor, districtId: "district-a", schoolId: "school-a", assetId: "asset-1", storageKey: "private/object-1", kind: "image", mimeType: "image/png", byteSize: 100 });
  // A new registry instance reads the same persisted row: no process-local registry state is required.
  const restartedRegistry = createPostgresMediaRegistry({ withTenantTransaction });
  const record = await restartedRegistry.getPrivateObject({ actor, districtId: "district-a", schoolId: "school-a", assetId: "asset-1" });
  assert.equal(record.storageKey, "private/object-1");
  await restartedRegistry.updatePrivateObject({ actor, districtId: "district-a", schoolId: "school-a", assetId: "asset-1", scanStatus: "clean", processingStatus: "processed" });
  assert.equal((await registry.getPrivateObject({ actor, districtId: "district-a", schoolId: "school-a", assetId: "asset-1" })).processingStatus, "processed");
  await assert.rejects(() => registry.getPrivateObject({ actor, districtId: "district-b", schoolId: "school-a", assetId: "asset-1" }), e => e.code === "media_registry_scope_required");
  await assert.rejects(() => registry.getPrivateObject({ actor, districtId: "district-a", schoolId: "school-b", assetId: "asset-1" }), e => e.code === "media_registry_scope_required");
  assert.ok(statements.every(sql => sql.includes("private_media_objects")));
  assert.equal(JSON.stringify(record).includes("private/object-1"), true, "storage key is internal registry data only");
});

test("PostgreSQL-backed pipeline composition always injects durable registry and authorization", () => {
  assert.throws(() => createPostgresBackedMediaPipeline(), /withTenantTransaction is required/);
  const pipeline = createPostgresBackedMediaPipeline({ withTenantTransaction: async (_actor, fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }) });
  assert.equal(pipeline.enabled, false, "no storage/scanner/processor adapters means media remains disabled");
});
