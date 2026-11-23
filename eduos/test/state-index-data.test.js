// STATE-01: the curated state index only carries checked, sourced, official links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JURISDICTIONS, ENTRIES, NATIONAL, CATEGORIES, curatedFor } from "../src/state-index-data.js";

test("all 50 states and DC, once each", () => {
  assert.equal(JURISDICTIONS.length, 51);
  assert.equal(new Set(JURISDICTIONS.map(j => j[0])).size, 51);
  assert.ok(JURISDICTIONS.some(j => j[0] === "DC"));
});

test("every curated link is https, sourced, dated, in a known category and a known state", () => {
  const codes = new Set(JURISDICTIONS.map(j => j[0]));
  for (const [code, list] of Object.entries(ENTRIES)) {
    assert.ok(codes.has(code), code);
    for (const e of list) checkEntry(e);
  }
  NATIONAL.forEach(checkEntry);
  function checkEntry(e) {
    assert.ok(CATEGORIES[e.category], e.title);
    for (const u of [e.url, e.source]) assert.match(u, /^https:\/\/(www\.)?(ed\.gov|nfhs\.org)\//, e.title);
    assert.match(e.checked, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("a state with no entries still gets the national directories", () => {
  assert.ok(curatedFor("WY").every(e => e.scope === "national") && curatedFor("WY").length === NATIONAL.length);
});
