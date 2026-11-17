// 37.6.0 well-being check-ins: the crisis rule, no scoring, consent wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as W from "../src/wellbeing-model.js";
import { ROLE_PERMISSIONS } from "../src/policy.js";

const sql = fs.readFileSync(new URL("../db/063_wellbeing_checkins.sql", import.meta.url), "utf8");
const grants = fs.readFileSync(new URL("../db/runtime_grants.template.sql", import.meta.url), "utf8");
const christie = fs.readFileSync(new URL("../src/christie-routes.js", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../src/wellbeing-routes.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../public/app/app.js", import.meta.url), "utf8");

test("crisis phrases are found through case, punctuation and contractions", () => {
  for (const t of ["I want to KILL MYSELF.", "i dont want to live anymore", "I don't want to live", "honestly... kms", "Someone is hurting me at home", "thinking about suicide"])
    assert.equal(W.detectCrisis(t).crisis, true, t);
});
test("ordinary words do not trigger the crisis rule", () => {
  for (const t of ["The skill kills me, it's hard", "my dog died last year", "I want to dine out", "3/4 of the pie", ""])
    assert.equal(W.detectCrisis(t).crisis, false, t);
});
test("the crisis response always shows the 988 Lifeline", () => {
  assert.equal(W.CRISIS_RESPONSE.tel, "tel:988");
  assert.ok(W.CRISIS_RESPONSE.lines.some(l => /988 Suicide & Crisis Lifeline/.test(l)));
});
test("check-in validation", () => {
  assert.deepEqual(W.validateCheckin({ mood: "low", needs: ["sleep", "sleep"], note: "  tired  " }), { mood: "low", needs: ["sleep"], note: "tired", wantsTalk: false });
  assert.equal(W.validateCheckin({ mood: "okay", needs: ["talk_to_someone"] }).wantsTalk, true);
  assert.throws(() => W.validateCheckin({ mood: "7/10" }), /mood_invalid/);
  assert.throws(() => W.validateCheckin({ mood: "low", needs: ["risk_score"] }), /needs_invalid/);
  assert.throws(() => W.validateCheckin({ mood: "low", note: "x".repeat(501) }), /note_too_long/);
});
test("queue order is two plain buckets then oldest first, never a score", () => {
  const items = [
    { id: "a", status: "new", created_at: "2026-01-01T10:00:00Z" },
    { id: "b", status: "new", wants_talk: true, created_at: "2026-01-01T11:00:00Z" },
    { id: "c", status: "seen", needs: ["safety"], created_at: "2026-01-01T09:00:00Z" },
    { id: "d", status: "closed", created_at: "2026-01-01T08:00:00Z" }];
  assert.deepEqual(W.orderQueue(items).map(i => `${i.id}:${i.bucket}`), ["c:now", "b:now", "a:today", "d:closed"]);
  for (const s of [sql, routes]) assert.doesNotMatch(s, /\b(risk_score|score|predict\w*|rank_by)\s*[:=(]/i);
});
test("no location, face or threat data in the schema", () => {
  assert.doesNotMatch(sql, /\b(latitude|longitude|geolocation|gps|face_|facial|threat_score|biometric)/i);
});
test("roles: pupil checks in, parent consents, counselor reads, superintendent sets; principals and teachers don't", () => {
  const want = { pupil: ["checkin"], parent: ["consent"], counselor: ["queue"], superintendent: ["settings"] };
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) assert.deepEqual(perms.wellbeing || [], want[role] || [], role);
});
test("migration 063: off by default, opt-in under the current notice, RLS, append-only, purge, counseling queue", () => {
  assert.match(sql, /checkins_enabled boolean NOT NULL DEFAULT false/);
  assert.match(sql, /decision='opted_in' AND notice_version=/);
  assert.match(sql, /'counseling',p_kind/);
  assert.doesNotMatch(sql.slice(sql.indexOf("FUNCTION eduos_wellbeing_open_work"), sql.indexOf("FUNCTION eduos_wellbeing_raise_alert")), /student_id|display_name|note/);
  assert.match(sql, /RENAME TO eduos_purge_student_pre_wellbeing/);
  assert.match(sql, /wellbeing_actions_append_only/);
  assert.match(grants, /REVOKE INSERT, DELETE, TRUNCATE ON wellbeing_alerts FROM eduos_app/);
  assert.match(grants, /REVOKE ALL ON FUNCTION eduos_wellbeing_open_work/);
});
test("Christie checks crisis words before any provider call and shows 988 in the app", () => {
  const hook = christie.indexOf("detectCrisis(text).crisis"), provider = christie.indexOf("p.help(");
  assert.ok(hook > 0 && hook < provider);
  assert.match(app, /if \(r\.crisis\) chat\.append\(wbCrisisCard\(r\.crisis\)\)/);
  assert.match(app, /SUBVIEWS\.push\("checkin", "wbconsent", "wbqueue", "wbsettings"\)/);
});
