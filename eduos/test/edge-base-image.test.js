import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Edge Phase 2: the edge containers ran on Fedora 40 for 18 months after it
// went out of support. containers/BASE_IMAGE records the base and its end of
// life; every edge Containerfile must use it, and this fails 30 days before
// that date so the move to the next Fedora happens while this one is patched.
const dir = new URL("../edge-platform/eduos/containers/", import.meta.url);
const meta = Object.fromEntries(fs.readFileSync(new URL("BASE_IMAGE", dir), "utf8").split("\n")
  .filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split(/=(.*)/s).slice(0, 2)));

test("every edge Containerfile uses the recorded base image", () => {
  assert.match(meta.IMAGE, /^docker\.io\/library\/fedora:\d+$/);
  const files = fs.readdirSync(dir).filter(f => f.startsWith("Containerfile."));
  assert.ok(files.length >= 3, "bootstrap, enrollment and health");
  const digests = new Set();
  for (const f of files) {
    const froms = [...fs.readFileSync(new URL(f, dir), "utf8").matchAll(/^FROM\s+(\S+)/gim)].map(m => m[1]);
    assert.equal(froms.length, 1, `${f}: one FROM`);
    const [image, digest] = froms[0].split("@");
    assert.equal(image, meta.IMAGE, `${f} must build FROM ${meta.IMAGE}`);
    assert.match(digest || "", /^sha256:[0-9a-f]{64}$/, `${f}: pin ${meta.IMAGE} to a digest`);
    digests.add(digest);
  }
  assert.equal(digests.size, 1, "every edge image uses the same base build");
});

test("the edge base image is at least 30 days from end of life", () => {
  assert.match(meta.END_OF_LIFE, /^\d{4}-\d\d-\d\d$/);
  const daysLeft = Math.floor((Date.parse(`${meta.END_OF_LIFE}T00:00:00Z`) - Date.now()) / 86_400_000);
  assert.ok(daysLeft >= 30, `${meta.IMAGE} reaches end of life on ${meta.END_OF_LIFE} (${daysLeft} days): move the edge containers to the next Fedora release and update containers/BASE_IMAGE`);
});

test("the health agent runs as a non-root user and the update agent has no image", () => {
  const health = fs.readFileSync(new URL("Containerfile.health", dir), "utf8");
  assert.match(health, /^USER 10003:10003$/m);
  assert.ok(!fs.existsSync(new URL("Containerfile.update", dir)), "eduos-update runs on the host");
});
