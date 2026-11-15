import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Supply chain (audit): CI must not run code that can change under a moving
// tag. Actions are pinned to full commit SHAs (Dependabot's github-actions
// updates keep them current), downloaded binaries are checked against a pinned
// SHA-256, and tools installed on the fly name an exact version.
const dir = new URL("../../.github/workflows/", import.meta.url);
const workflows = fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).map(f => [f, fs.readFileSync(new URL(f, dir), "utf8")]);

test("every action is pinned to a full commit SHA, with its version noted", () => {
  assert.ok(workflows.length >= 2);
  for (const [f, text] of workflows) {
    for (const m of text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)) {
      if (m[1].startsWith("./")) continue; // local actions
      assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: ${m[1]} must be pinned to a commit SHA`);
      assert.match(m[2], /#\s*v\d+(\.\d+){1,2}/, `${f}: ${m[1]} needs a "# vX.Y.Z" comment`);
    }
  }
});

test("downloaded binaries are verified against a pinned SHA-256", () => {
  for (const [f, text] of workflows) {
    for (const m of text.matchAll(/(?:curl|wget)\b[^\n]*?-o\s+(\S+)/g)) {
      const file = m[1];
      const re = new RegExp(`[0-9a-f]{64}\\s+${file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"?\\s*\\|\\s*sha256sum -c`);
      assert.match(text, re, `${f}: ${file} is downloaded without a pinned sha256sum -c check`);
    }
  }
});

test("tools installed during CI name an exact version", () => {
  for (const [f, text] of workflows) {
    for (const m of text.matchAll(/npm install\b([^\n]*)/g)) {
      for (const pkg of m[1].split(/\s+/).filter(a => a && !a.startsWith("-") && !a.startsWith("\"") && !a.startsWith("$"))) {
        assert.match(pkg, /@\d+\.\d+\.\d+$/, `${f}: "npm install ${pkg}" must pin an exact version`);
      }
    }
  }
});
