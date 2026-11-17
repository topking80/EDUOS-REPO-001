// 2026-11-17 audit: package.json said 37.5.0 while main carried the 37.6 and
// 37.7.0 work. The package version must be at least the newest release named
// in the release notes, and the top-level notes and README must exist for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { RELEASE, assertReleaseMetadataAligned } from "./helpers/release.js";

const root = new URL("../", import.meta.url);
const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

test("no release-candidate note is newer than package.json", () => {
  const versions = readdirSync(new URL("docs/release-candidates/", root))
    .map(f => /^(\d+\.\d+\.\d+)-/.exec(f)?.[1]).filter(Boolean).sort(cmp);
  const newest = versions[versions.length - 1];
  assert.ok(newest, "release-candidate notes exist");
  assert.ok(cmp(RELEASE, newest) >= 0, `package.json is ${RELEASE} but docs/release-candidates names ${newest}`);
});

test("the package version has top-level release notes and the README names it", () => {
  assert.ok(existsSync(new URL(`RELEASE-NOTES-${RELEASE}.md`, root)), `RELEASE-NOTES-${RELEASE}.md`);
  assert.match(readFileSync(new URL("README.md", root), "utf8").split("\n")[0], new RegExp(`^# EduOS District Edition ${RELEASE.replace(/\./g, "\\.")}$`));
  assertReleaseMetadataAligned();
});
