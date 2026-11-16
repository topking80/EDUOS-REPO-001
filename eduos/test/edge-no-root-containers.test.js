// EDUOS-SUP-01: no edge container runs as root. Bootstrap provisions the node
// and runs as a host unit with systemd limits; the root bootstrap container
// was removed (it was never started: the host unit of the same name won).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";

const edge = p => new URL(`../edge-platform/eduos/${p}`, import.meta.url);
const read = p => readFileSync(edge(p), "utf8");

test("every edge image we build sets a non-root USER, and there is no bootstrap image", () => {
  const files = readdirSync(edge("containers")).filter(f => f.startsWith("Containerfile."));
  assert.ok(files.length >= 2, files.join(","));
  assert.ok(!files.includes("Containerfile.bootstrap"));
  for (const f of files) {
    const user = /^USER\s+(\S+)/m.exec(read(`containers/${f}`))?.[1];
    assert.ok(user && !/^(root|0)(:|$)/.test(user), `${f} runs as ${user ?? "root (no USER)"}`);
  }
});

test("no Quadlet runs bootstrap; the bootstrap host unit keeps its limits", () => {
  assert.ok(!existsSync(edge("quadlet/eduos-bootstrap.container")));
  for (const f of readdirSync(edge("butane")).filter(f => f.endsWith(".bu")))
    assert.doesNotMatch(read(`butane/${f}`), /eduos-bootstrap\.container/, f);
  const unit = read("services/bootstrap.service");
  for (const line of ["NoNewPrivileges=true", "ProtectSystem=strict", "ProtectHome=true", "ReadWritePaths=/etc/eduos /var/lib/eduos"])
    assert.ok(unit.includes(line), `bootstrap.service keeps ${line}`);
});

test("every EduOS-built Quadlet container forbids privilege escalation", () => {
  for (const f of readdirSync(edge("quadlet")).filter(f => f.endsWith(".container")))
    assert.match(read(`quadlet/${f}`), /^NoNewPrivileges=true$/m, f);
});

test("no Trivy root-user exception remains", () => {
  const ignore = readFileSync(new URL("../../.trivyignore.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(ignore, /Containerfile\.bootstrap|id:\s*(AVD-)?DS-?0002/);
});
