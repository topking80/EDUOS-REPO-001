import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('production requires HTTPS origin and HTTPS OIDC issuer', async () => {
  const config = await read('../src/config.js');
  assert.match(config, /config\.nodeEnv === "production" && !config\.publicOrigin\.startsWith\("https:\/\/"\)/);
  assert.match(config, /config\.nodeEnv === "production" && !config\.oidcIssuer\.startsWith\("https:\/\/"\)/);
});

test('production database transport is encrypted unless an explicitly private host exception is enabled', async () => {
  const config = await read('../src/config.js');
  assert.match(config, /config\.nodeEnv === "production" && !config\.databaseSsl/);
  assert.match(config, /config\.databaseSslAllowPrivateNetwork && isPrivateDatabaseHost\(databaseUrl\.hostname\)/);
});

test('runtime database role cannot bypass PostgreSQL row-level security', async () => {
  const migrate = await read('../src/migrate.js');
  assert.match(migrate, /rolsuper \|\| role\.rows\[0\]\.rolbypassrls/);
  assert.match(migrate, /must not own the EduOS tables/);
});

test('tenant transactions establish district, user, role and school context transaction-locally', async () => {
  const db = await read('../src/db.js');
  assert.match(db, /set_config\('app\.district_id', \$1, true\)/);
  assert.match(db, /set_config\('app\.user_id', \$2, true\)/);
  assert.match(db, /set_config\('app\.role', \$3, true\)/);
  assert.match(db, /set_config\('app\.school_id', \$4, true\)/);
});

test('session defaults fail closed: no session cache, bounded lifetime and idle timeout', async () => {
  const config = await read('../src/config.js');
  assert.match(config, /sessionCacheTtlMs: Math\.max\(0, Number\(process\.env\.SESSION_CACHE_TTL_MS \|\| 0\)\)/);
  assert.match(config, /sessionTtlHours: Number\(process\.env\.SESSION_TTL_HOURS \|\| 8\)/);
  assert.match(config, /sessionIdleMinutes: Number\(process\.env\.SESSION_IDLE_MINUTES \|\| 30\)/);
});

test('security headers and anti-forgery middleware are installed', async () => {
  const server = await read('../src/server.js');
  assert.match(server, /app\.use\(helmet\(/);
  assert.match(server, /app\.post\("\/auth\/logout",requireSession,requireCsrf/);
  assert.match(server, /app\.post\("\/api\/session\/membership",requireSession,requireCsrf/);
});

test('CSP allows no inline script: the legacy interface migrated to external files', async () => {
  const server = await read('../src/server.js');
  const { cspDirectives } = await import('../src/csp.js');
  assert.match(server, /contentSecurityPolicy: \{ directives: cspDirectives \}/);
  assert.deepEqual(cspDirectives.scriptSrc, ["'self'"]);
  assert.deepEqual(cspDirectives.scriptSrcAttr, ["'none'"]);
});
