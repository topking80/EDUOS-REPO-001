import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const compose = fs.readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const caddy = fs.readFileSync(new URL("../Caddyfile", import.meta.url), "utf8");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("app has no host-published API port", () => {
  const app = compose.split(/^  app:/m)[1].split(/^  edge:/m)[0];
  assert.doesNotMatch(app, /^\s{4}ports:/m);
});

test("database is isolated from public edge network", () => {
  const db = compose.split(/^  db:/m)[1].split(/^  migrate:/m)[0];
  assert.match(db, /- backend/);
  assert.doesNotMatch(db, /edge_net/);
});

test("trusted proxy is limited to the dedicated edge address", () => {
  // 32.1.0: the edge address is configurable (EDUOS_EDGE_IP); the trusted proxy
  // default is derived from the same variable, so they cannot drift apart.
  assert.match(compose, /TRUSTED_PROXY_IPS:\s*\$\{TRUSTED_PROXY_IPS:-\$\{EDUOS_EDGE_IP:-172\.30\.0\.2\}\/32\}/);
  assert.match(compose, /ipv4_address:\s*\$\{EDUOS_EDGE_IP:-172\.30\.0\.2\}/);
  assert.match(compose, /ip_range: \$\{EDUOS_EDGE_IP_RANGE:-172\.30\.0\.128\/25\}/);
});

test("non-fingerprinted assets are not marked immutable", () => {
  assert.match(caddy, /max-age=3600, must-revalidate/);
  assert.doesNotMatch(caddy, /max-age=[^"]*, immutable/);
});

test("missing static assets do not receive SPA index fallback", () => {
  assert.match(caddy, /@missingAsset path_regexp/);
  assert.match(caddy, /handle @missingAsset\s*\{\s*file_server\s*\}/);
});

test("release version is updated", () => {
  assert.equal(pkg.version, "35.6.0");
});
