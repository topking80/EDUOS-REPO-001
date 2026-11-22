import test from "node:test";
import assert from "node:assert/strict";
import { getCookie } from "../src/cookies.js";

test("getCookie reads one named cookie and ignores the rest", () => {
  assert.equal(getCookie("a=1; eduos_lti_ab=x%2By; b=2", "eduos_lti_ab"), "x+y");
  assert.equal(getCookie("eduos_lti_ab=first; eduos_lti_ab=second", "eduos_lti_ab"), "first");
  assert.equal(getCookie("__proto__=1; constructor=2", "eduos_lti_ab"), undefined);
  assert.equal(getCookie(undefined, "x"), undefined);
  assert.equal(getCookie("x=%E0%A4%A", "x"), "%E0%A4%A");
  assert.equal(getCookie("xx=1", "x"), undefined, "exact name only");
});
