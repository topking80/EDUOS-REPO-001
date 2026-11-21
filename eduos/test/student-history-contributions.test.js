import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../db/087_student_history_guardian_contributions.sql", import.meta.url), "utf8");
const routes = readFileSync(new URL("../src/student-history-contribution-routes.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const grants = readFileSync(new URL("../db/runtime_grants.template.sql", import.meta.url), "utf8").replace(/\\s+/g, " ");

test("TC-02 contributions are tenant/school scoped and keep a review decision record", () => {
  assert.match(migration, /ALTER TABLE %I ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE %I FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /student_history_contributions_district_school_scope/);
  assert.match(migration, /student_history_contribution_events_append_only/);
  assert.match(migration, /status IN \\('submitted','approved','rejected','withdrawn'\\)/);
  assert.match(migration, /history_entry_id uuid/);
});

test("guardian submission rechecks active relationship and accepts only text/date fields", () => {
  assert.match(routes, /relationship IN \\('parent','guardian'\\)/);
  assert.match(routes, /status='active'/);
  assert.match(routes, /Object.keys\\(body\\).some/);
  assert.match(routes, /requireCsrf/);
  assert.match(routes, /student_history_contribution_events/);
});

test("approval is a transactional moderation gate and creates only a family-memory entry", () => {
  assert.match(routes, /status !== "submitted"/);
  assert.match(routes, /classification, title, body, occurred_at, audience, status, source_type/);
  assert.match(routes, /'family_memory'.*'family'.*'published'.*'guardian'/s);
  assert.match(routes, /FOR UPDATE/);
  assert.match(routes, /audit\\(/);
});

test("reviewers are limited to principal and superintendent; no parent approval path", () => {
  assert.match(routes, /const canReview = role => role === "principal" \|\| role === "superintendent"/);
  assert.match(routes, /school_reviewer_required/);
});

test("TC-02 routes are registered and runtime grants are least-privilege", () => {
  assert.match(server, /registerStudentHistoryContributionRoutes/);
  assert.match(grants, /GRANT SELECT, INSERT ON student_history_contributions TO eduos_app/);
  assert.match(grants, /GRANT UPDATE \\(status, reviewed_by, reviewed_at, review_note, history_entry_id, updated_at\\) ON student_history_contributions TO eduos_app/);
  assert.match(grants, /REVOKE UPDATE, DELETE, TRUNCATE ON student_history_contribution_events FROM eduos_app/);
});
