// Deployment configuration regression tests (32.0.53): findings 1, 10, 11, 22.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const compose = read("docker-compose.yml");
const caddy = read("Caddyfile");
const envExample = read(".env.example");
const initRoles = read("db/init/00-eduos-roles.sh");
const service = name => compose.split(new RegExp(`^  ${name}:`, "m"))[1].split(/^  [a-z]+:\n/m)[0];

test("compose has no default database passwords", () => {
  assert.doesNotMatch(compose, /change-this/);
  for (const v of ["POSTGRES_PASSWORD", "EDUOS_OWNER_PASSWORD", "EDUOS_APP_PASSWORD"])
    assert.match(compose, new RegExp(`\\$\\{${v}:\\?`), v);
});

test("the API connects as the runtime role; migrate/retention use the owner role", () => {
  assert.match(service("app"), /DATABASE_URL: postgres:\/\/eduos_app:/);
  assert.match(service("migrate"), /DATABASE_URL: postgres:\/\/eduos_owner:/);
  assert.match(service("migrate"), /EDUOS_APP_ROLE: eduos_app/);
  assert.match(service("retention"), /DATABASE_URL: postgres:\/\/eduos_owner:/);
  assert.match(service("db"), /\.\/db\/init:\/docker-entrypoint-initdb\.d:ro/);
  assert.match(initRoles, /CREATE ROLE eduos_app LOGIN NOSUPERUSER [A-Z ]*NOBYPASSRLS/);
  assert.match(initRoles, /ALTER DATABASE :"dbname" OWNER TO eduos_owner/);
});

test("compose can run in production mode against the internal database", () => {
  assert.match(service("app"), /DATABASE_SSL_ALLOW_PRIVATE_NETWORK: "true"/);
  assert.match(compose, /backend:\n\s+internal: true/);
});

test("Caddy edge sets security headers for static assets", () => {
  for (const h of ["Content-Security-Policy", "X-Content-Type-Options \"nosniff\"", "Strict-Transport-Security \"max-age=31536000", "X-Frame-Options"])
    assert.ok(caddy.includes(h), h);
  assert.match(caddy, /frame-ancestors 'self'/);
});

test(".env.example has one TRUSTED_PROXY_IPS consistent with the compose edge network", () => {
  assert.equal(envExample.match(/^TRUSTED_PROXY_IPS=/gm).length, 1);
  assert.doesNotMatch(envExample, /172\.29\./);
  // 32.1.0: configurable subnet; the default is unchanged.
  assert.match(compose, /subnet: \$\{EDUOS_EDGE_SUBNET:-172\.30\.0\.0\/24\}/);
  assert.doesNotMatch(envExample, /change-this|replace-me/);
});
