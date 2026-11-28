// SEC-02: the "broad policy" rule the integration coverage test relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBroad, isOwnerOnly } from "./integration/rls-coverage-rules.js";

test("district, school, role and owner checks are broad; anything naming a person or a per-student function is not", () => {
  for (const q of [
    "(district_id = (NULLIF(current_setting('app.district_id'::text, true), ''::text))::uuid)",
    "(eduos_is_table_owner() OR (district_id = eduos_ctx_district()))",
    "((district_id = (NULLIF(current_setting('app.district_id'::text, true), ''::text))::uuid) AND ((school_id = (NULLIF(current_setting('app.school_id'::text, true), ''::text))::uuid) OR (current_setting('app.role'::text, true) = ANY (ARRAY['superintendent'::text, 'it_admin'::text]))))",
    null,
  ]) assert.equal(isBroad(q), true, q);
  for (const q of [
    "(eduos_is_table_owner() OR eduos_can_see_submission(assignment_id, student_id))",
    "((district_id = eduos_ctx_district()) AND (guardian_user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid))",
    "(eduos_is_table_owner() OR eduos_can_see_learning(school_id, student_id))",
  ]) assert.equal(isBroad(q), false, q);
});

test("a policy that only lets the table owner through grants the runtime role nothing", () => {
  assert.equal(isOwnerOnly("eduos_is_table_owner()"), true);
  assert.equal(isOwnerOnly("(eduos_is_table_owner() OR (district_id = eduos_ctx_district()))"), false);
  assert.equal(isOwnerOnly(null), false);
});
