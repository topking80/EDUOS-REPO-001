// Static files are served by Caddy and never reach the Node app, so the
// Content Security Policy in the Caddyfile is the one browsers get for them.
// It must be the app's policy (src/csp.js), directive for directive: it used
// to keep 'unsafe-inline' for scripts after the app had dropped it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import helmet from "helmet";
import { cspDirectives } from "../src/csp.js";

const parse = (header) => Object.fromEntries(header.split(";").map(d => d.trim()).filter(Boolean).map(d => { const [name, ...v] = d.split(/\s+/); return [name, v.sort().join(" ")]; }));

/** The header the app really sends: helmet with the same directives server.js gives it. */
function appHeader() {
  let value;
  helmet({ contentSecurityPolicy: { directives: cspDirectives } })({}, { setHeader: (k, v) => { if (/^content-security-policy$/i.test(k)) value = v; }, removeHeader() {} }, () => {});
  return value;
}

test("the Caddyfile's CSP is the app's CSP", () => {
  const caddy = /\?Content-Security-Policy "([^"]+)"/.exec(readFileSync(new URL("../Caddyfile", import.meta.url), "utf8"));
  assert.ok(caddy, "Caddyfile sets a Content-Security-Policy");
  const app = appHeader();
  assert.ok(app, "the app sets a Content-Security-Policy");
  assert.deepEqual(parse(caddy[1]), parse(app));
});

test("neither allows inline script", () => {
  const caddy = parse(/\?Content-Security-Policy "([^"]+)"/.exec(readFileSync(new URL("../Caddyfile", import.meta.url), "utf8"))[1]);
  for (const policy of [caddy, parse(appHeader())]) {
    assert.equal(policy["script-src"], "'self'");
    assert.equal(policy["script-src-attr"], "'none'");
  }
});
