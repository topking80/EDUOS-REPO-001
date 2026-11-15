import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The mobile offline queue replays a write only under the identity that made it.
// It names a membership by (user, district, school, role) instead of a membership
// id, which is sound only while the database keeps that tuple unique. If the
// constraint changes, this fails so the queue owner key gets revisited too.
const db = (f) => fs.readFileSync(new URL(`../db/${f}`, import.meta.url), "utf8");
const queue = fs.readFileSync(new URL("../mobile/flutter/lib/core/offline_queue.dart", import.meta.url), "utf8");

test("a membership is unique by (user, district, school, role), NULL school included", () => {
  const migrations = fs.readdirSync(new URL("../db/", import.meta.url)).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  let current = null;
  for (const f of migrations) {
    const sql = db(f);
    if (/ALTER TABLE memberships DROP CONSTRAINT (IF EXISTS )?memberships_user_scope_role_key/.test(sql)) current = null;
    const m = sql.match(/ADD CONSTRAINT memberships_user_scope_role_key\s+UNIQUE NULLS NOT DISTINCT \(([^)]*)\)/);
    if (m) current = m[1].split(",").map(x => x.trim());
  }
  assert.deepEqual(current, ["user_id", "district_id", "school_id", "role"]);
});

test("the queue owner key is exactly server + that tuple", () => {
  assert.match(queue, /String get key => \[server, userId, districtId, role, schoolId \?\? '-'\]\.join\('\|'\);/);
});
