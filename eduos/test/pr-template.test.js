// The PR template asks every change for what the Nov 27 repository audit
// requires (apps, endpoints, migrations, authorization, tests, release
// dependencies) and carries the governance checklist, so those prompts
// can't be dropped by accident.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const template = readFileSync(new URL("../../.github/pull_request_template.md", import.meta.url), "utf8");

test("the PR template asks for every field the audit requires", () => {
  for (const heading of ["What and why", "Applications affected", "API endpoints", "Database migrations", "Authorization rules", "Tests", "Release dependencies", "Governance checklist"])
    assert.match(template, new RegExp(`^## ${heading}$`, "m"), heading);
  for (const app of ["Student", "Parent / guardian", "Teacher", "Principal", "Vice principal", "Nurse", "Maintenance", "Bus driver", "SRO / safety"])
    assert.ok(template.includes(`- [ ] ${app}`), app);
});

test("the governance checklist keeps every standing rule", () => {
  for (const rule of [
    "No vendor gets unrestricted student-data access.",
    "No external grade changes without district authorization.",
    "No weakening of existing RLS or school boundaries.",
    "No automatic student transfers.",
    "No unapproved third-party data sharing.",
    "No compliance claims without documented evidence and appropriate review.",
    "No GPS tracking of bus drivers",
  ]) assert.ok(template.includes(rule), rule);
});
