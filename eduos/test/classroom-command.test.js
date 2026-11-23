// DEV-03: each classroom command takes only its own, checked arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../src/classroom-command.js";

test("commands take only their own arguments", () => {
  assert.deepEqual(parseCommand("show", { anything: 1 }), {});
  assert.deepEqual(parseCommand("blank", { on: true }), { on: true });
  assert.equal(parseCommand("blank", { on: "yes" }), null);
  assert.deepEqual(parseCommand("volume", { level: 40 }), { level: 40 });
  assert.equal(parseCommand("volume", { level: 101 }), null);
  assert.equal(parseCommand("volume", { level: 4.5 }), null);
  assert.deepEqual(parseCommand("input", { source: " HDMI 2 " }), { source: "HDMI 2" });
  assert.equal(parseCommand("input", { source: "<script>" }), null);
  assert.deepEqual(parseCommand("lights", { on: true, level: 60 }), { on: true, level: 60 });
  assert.deepEqual(parseCommand("lock", { message: " Eyes up front " }), { message: "Eyes up front" });
  assert.deepEqual(parseCommand("lock", {}), {});
  assert.equal(parseCommand("lock", { message: "x".repeat(121) }), null);
});

test("links are https only, no credentials", () => {
  assert.deepEqual(parseCommand("open_link", { url: "https://example.org/a" }), { url: "https://example.org/a" });
  for (const url of ["http://example.org", "javascript:alert(1)", "https://u:p@example.org", "file:///etc/passwd", ""]) assert.equal(parseCommand("open_link", { url }), null, url);
  assert.deepEqual(parseCommand("focus", { off: true }), { off: true });
  assert.deepEqual(parseCommand("focus", { url: "https://example.org" }), { url: "https://example.org" });
  assert.equal(parseCommand("focus", {}), null);
});

test("there is no command that views a screen", () => {
  for (const c of ["view_screen", "screenshot", "capture", "stream", "record", "watch"]) assert.equal(parseCommand(c, {}), null, c);
  assert.equal(parseCommand("lock", null), null);
  assert.equal(parseCommand("lock", []), null);
});
