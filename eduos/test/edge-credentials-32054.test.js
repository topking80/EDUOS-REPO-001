// 32.0.54 edge hardening: no committed credentials or placeholders, kiosk
// account without admin rights, deprecated reference tree refuses to build.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EDGE = path.join(ROOT, "edge-platform/eduos");
const pyEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const which = cmd => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim();
const butane = process.env.BUTANE || which("butane");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "build", "secrets"].includes(entry.name)) continue;
    const p = path.join(dir, entry.name);
    entry.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const CONFIG_EXT = /\.(bu|ign|ya?ml|json|service|container|conf|toml|sh|py|rules|txt)$/;

test("no committed placeholder credentials or tokens in any edge/deploy config", () => {
  const offenders = [];
  for (const file of walk(ROOT).filter(f => CONFIG_EXT.test(f) && !f.includes(`${path.sep}test${path.sep}`) && !f.includes(`${path.sep}tests${path.sep}`))) {
    const text = fs.readFileSync(file, "utf8");
    if (/\$6\$rounds=4096\$CHANGE_(ME|THIS_HASH)\$/.test(text) || /AAAAC3NzaC1lZDI1NTE5AAAAI\.\.\.REPLACE/.test(text) ||
        /EDUOS-STUDENT-ENROLL-TOKEN-PLACEHOLDER/.test(text))
      offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, []);
});

test("no Ignition output is shipped (it would contain password hashes)", () => {
  const shipped = walk(ROOT).filter(f => f.endsWith(".ign"));
  assert.deepEqual(shipped.map(f => path.relative(ROOT, f)), []);
  assert.match(fs.readFileSync(path.join(EDGE, ".gitignore"), "utf8"), /^ignition\/\*\.ign$/m);
});

test("edge config lint passes (no hashes/keys/tokens committed, student not in wheel)", { skip: !hasPython && "python3 not installed" }, () => {
  const r = spawnSync("python3", ["scripts/eduos-edge-config.py", "lint"], { cwd: EDGE, encoding: "utf8", env: pyEnv });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("edge credential and lint unit tests (python)", { skip: !hasPython && "python3 not installed" }, () => {
  const r = spawnSync("python3", ["-m", "unittest", "tests/test_edge_config.py"], { cwd: EDGE, encoding: "utf8", env: pyEnv });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("every role compiles under butane --strict with throw-away credentials", { skip: (!hasPython || !butane) && "python3/butane not available (set BUTANE=/path/to/butane)" }, () => {
  const r = spawnSync("python3", ["scripts/eduos-edge-config.py", "check", "--butane", butane], { cwd: EDGE, encoding: "utf8", env: pyEnv });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /check: student ok/);
});

test("building without credentials fails loudly", { skip: !hasPython && "python3 not installed" }, () => {
  const env = { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", EDUOS_EDGE_SECRETS: "/nonexistent/edge.env" };
  const r = spawnSync("python3", ["scripts/eduos-edge-config.py", "render", "student", "/dev/null"], { cwd: EDGE, encoding: "utf8", env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /EDUOS_STUDENT_PASSWORD_HASH is not set/);
});

test("student kiosk polkit rule allows only own-session power actions", () => {
  const rules = [];
  const polkit = { Result: { YES: "yes", NO: "no", NOT_HANDLED: "nh" }, addRule: fn => rules.push(fn) };
  vm.runInNewContext(fs.readFileSync(path.join(EDGE, "configs/polkit/50-eduos-student-kiosk.rules"), "utf8"), { polkit });
  const decide = (id, subject) => rules[0]({ id }, { local: true, active: true, ...subject });
  assert.equal(decide("org.freedesktop.login1.reboot", { user: "student" }), "yes");
  assert.equal(decide("org.freedesktop.login1.power-off", { user: "student" }), "yes");
  assert.equal(decide("org.freedesktop.login1.reboot", { user: "student", local: false }), "no");
  assert.equal(decide("org.freedesktop.login1.reboot", { user: "student", active: false }), "no");
  assert.equal(decide("org.freedesktop.systemd1.manage-units", { user: "student" }), "no");
  assert.equal(decide("org.freedesktop.NetworkManager.settings.modify.system", { user: "student" }), "no");
  assert.equal(decide("org.freedesktop.systemd1.manage-units", { user: "eduos-admin" }), "nh");
  const bu = fs.readFileSync(path.join(EDGE, "butane/student.bu"), "utf8");
  assert.match(bu, /local: configs\/polkit\/50-eduos-student-kiosk\.rules/);
});

test("deprecated edge reference tree refuses to build", { skip: !which("make") && "make not installed" }, () => {
  const r = spawnSync("make", ["-C", path.join(ROOT, "platform/edge-runtime-reference"), "ignition"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /deprecated/);
});

test("edge Makefile has no duplicate targets", { skip: !which("make") && "make not installed" }, () => {
  const r = spawnSync("make", ["-n", "-C", EDGE, "usb"], { encoding: "utf8" });
  assert.doesNotMatch(r.stderr, /overriding recipe|ignoring old recipe/);
});
