import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../db/087_student_history_guardian_contributions.sql", import.meta.url), "utf8");
const routes = readFileSync(new URL("../src/student-history-contribution-routes.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const grants = readFileSync(new URL("../db/runtime_grants.template.sql", import.meta.url), "utf8").replace(/\s+/g, " ");

test("TC-02 contributions use forced RLS and an append-only decision log", () => {
  assert.ok(migration.includes("ALTER TABLE %I ENABLE ROW LEVEL SECURITY"));
  assert.ok(migration.includes("ALTER TABLE %I FORCE ROW LEVEL SECURITY"));
  assert.ok(migration.includes("t || '_district_school_scope'"));
  assert.ok(migration.includes("ARRAY['student_history_contributions','student_history_contribution_events']"));
  assert.ok(migration.includes("student_history_contribution_events_append_only"));
  assert.ok(migration.includes("status IN ('submitted','approved','rejected','withdrawn')"));
  assert.ok(migration.includes("history_entry_id uuid"));
  assert.ok(migration.includes("current_setting(''app.user_id'', true)"));
  assert.ok(migration.includes("l.relationship IN (''parent'',''guardian'')"));
});

test("guardian submission rechecks an active relationship and rejects unexpected fields", () => {
  assert.ok(routes.includes("relationship IN ('parent','guardian')"));
  assert.ok(routes.includes("status='active'"));
  assert.ok(routes.includes("Object.keys(body).some"));
  assert.ok(routes.includes("requireCsrf"));
  assert.ok(routes.includes("invalid_contribution_withdrawal"));
  assert.ok(routes.includes("status='withdrawn'"));
  assert.ok(routes.includes("student_history_contribution_events"));
  assert.ok(routes.includes('if (!validId(studentId)) throw new HttpError(400, "invalid_student_id")'));
});

test("approval is transactional and publishes only a family-memory history entry", () => {
  assert.ok(routes.includes('contribution.status !== "submitted"'));
  assert.ok(routes.includes("contribution_self_review_forbidden"));
  assert.ok(routes.includes("'reflection','family_memory'"));
  assert.ok(routes.includes("'family','published','guardian'"));
  assert.ok(routes.includes("FOR UPDATE"));
  assert.ok(routes.includes('audit(client, req, status, "student_history_contribution"'));
});

test("reviewers are limited to principal and superintendent", () => {
  assert.ok(routes.includes('const canReview = role => role === "principal" || role === "superintendent"'));
  assert.ok(routes.includes("school_reviewer_required"));
});

test("routes are registered and runtime grants do not grant table-wide UPDATE", () => {
  assert.ok(server.includes("registerStudentHistoryContributionRoutes"));
  assert.ok(grants.includes("GRANT SELECT, INSERT ON student_history_contributions TO eduos_app;"));
  assert.ok(grants.includes("GRANT UPDATE (status, reviewed_by, reviewed_at, review_note, history_entry_id, updated_at) ON student_history_contributions TO eduos_app;"));
  assert.ok(!grants.includes("GRANT SELECT, INSERT, UPDATE ON student_history_contributions"));
  assert.ok(grants.includes("REVOKE UPDATE, DELETE, TRUNCATE ON student_history_contribution_events FROM eduos_app;"));
});
