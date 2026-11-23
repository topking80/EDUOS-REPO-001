// SPORTS-01: only MaxPreps / Hudl links; CSV cells can't become formulas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serviceLink, csvCell, csv, splitName } from "../src/sports-sharing.js";

test("links stay on each service's own site", () => {
  assert.equal(serviceLink("maxpreps", "https://www.maxpreps.com/ny/x/varsity/football/"), "https://www.maxpreps.com/ny/x/varsity/football/");
  assert.equal(serviceLink("hudl", "https://www.hudl.com/team/v2/123"), "https://www.hudl.com/team/v2/123");
  for (const [s, u] of [["maxpreps", "https://www.hudl.com/team/1"], ["hudl", "https://hudl.com.evil.example/x"], ["hudl", "http://www.hudl.com/x"],
    ["maxpreps", "https://u:p@maxpreps.com/x"], ["maxpreps", "https://evilmaxpreps.com/x"], ["other", "https://www.hudl.com/x"], ["hudl", null]])
    assert.equal(serviceLink(s, u), null, `${s} ${u}`);
});

test("CSV cells are quoted and can't run as formulas", () => {
  assert.equal(csvCell("Alice"), "Alice");
  assert.equal(csvCell("=HYPERLINK(\"x\")"), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("-5"), "'-5");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell("a,b"), `"a,b"`);
  assert.equal(csvCell(null), "");
  assert.equal(csv(["A", "B"], [[1, "x"]]), "A,B\r\n1,x\r\n");
});

test("names split into first and last", () => {
  assert.deepEqual(splitName("Ana María López"), ["Ana", "María López"]);
  assert.deepEqual(splitName("Cher"), ["Cher", ""]);
});
