import test from "node:test";
import assert from "node:assert/strict";
import { canPerform } from "../src/policy.js";

const base = { userId:"user-1", districtId:"district-1", schoolId:"school-1" };
test("superintendent can read and export district audit",()=>{
  assert.equal(canPerform({...base,role:"superintendent"},"audit","read"),true);
  assert.equal(canPerform({...base,role:"superintendent"},"audit","export"),true);
});
test("principal can read but not export audit",()=>{
  assert.equal(canPerform({...base,role:"principal"},"audit","read"),true);
  assert.equal(canPerform({...base,role:"principal"},"audit","export"),false);
});
test("teacher can grade but cannot approve cases",()=>{
  assert.equal(canPerform({...base,role:"teacher"},"assignments","grade"),true);
  assert.equal(canPerform({...base,role:"teacher"},"cases","approve"),false);
});
test("parent can acknowledge attendance but cannot create attendance",()=>{
  assert.equal(canPerform({...base,role:"parent"},"attendance","acknowledge"),true);
  assert.equal(canPerform({...base,role:"parent"},"attendance","create"),false);
});
test("pupil can submit assignments but cannot read audit",()=>{
  assert.equal(canPerform({...base,role:"pupil"},"assignments","submit"),true);
  assert.equal(canPerform({...base,role:"pupil"},"audit","read"),false);
});
test("missing district/user context is denied",()=>{
  assert.equal(canPerform({role:"superintendent",userId:"u"},"schools","read"),false);
});

test("parent and pupil cannot inspect district audit",()=>{
  assert.equal(canPerform({...base,role:"parent"},"audit","read"),false);
  assert.equal(canPerform({...base,role:"pupil"},"audit","read"),false);
});
