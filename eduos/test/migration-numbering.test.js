// Migrations after 050 run in file-name order (src/migrate.js). Two files with
// the same number run in one order on a new database and in merge order on an
// upgraded one, so their schemas can differ. New migrations take the next free
// number. The two pairs below shipped before this check and can't be renamed:
// upgraded databases record migrations by file name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

const SHIPPED_DUPLICATES = new Map([
  ["083", ["083_commerce_refund_case_immutability.sql", "083_timeline_authorization_foundation.sql"]],
  ["086", ["086_sis_scheduled_sync_foundation.sql", "086_student_history_time_capsule.sql"]]
]);

const files = readdirSync(new URL("../db/", import.meta.url)).filter(f => /^\d{3}_.+\.sql$/.test(f)).sort();

test("every migration file is named NNN_lowercase_words.sql", () => {
  for (const f of files) assert.match(f, /^\d{3}_[a-z0-9_]+\.sql$/, f);
});

test("no new migration reuses a number", () => {
  const byNumber = new Map();
  for (const f of files) byNumber.set(f.slice(0, 3), [...(byNumber.get(f.slice(0, 3)) || []), f]);
  for (const [n, names] of byNumber) {
    if (names.length === 1) continue;
    assert.deepEqual(names, SHIPPED_DUPLICATES.get(n),
      `migration number ${n} is used by ${names.join(", ")}; give the newer file the next free number (${String(Math.max(...[...byNumber.keys()].map(Number)) + 1).padStart(3, "0")})`);
  }
});

test("the shipped duplicate pairs are still exactly those files (never renamed)", () => {
  for (const names of SHIPPED_DUPLICATES.values()) for (const f of names) assert.ok(files.includes(f), `${f} must not be renamed or removed`);
});
