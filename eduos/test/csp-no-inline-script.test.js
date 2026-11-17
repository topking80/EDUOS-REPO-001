// The Content Security Policy forbids inline script (no 'unsafe-inline' in
// script-src or script-src-attr). These checks keep it that way: no inline
// <script> or on*= handler in any served page or in HTML built by its scripts,
// and every data-on-* handler is one legacy-events.js knows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import helmet from "helmet";
import { cspDirectives } from "../src/csp.js";

const pub = new URL("../public/", import.meta.url).pathname;
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]);
const served = files(pub).filter(f => /\.(html?|js)$/.test(f));
const read = (f) => readFileSync(f, "utf8");

test("no inline <script> in any served page", () => {
  for (const f of served.filter(f => /\.html?$/.test(f)))
    for (const tag of read(f).match(/<script\b[^>]*>/gi) || []) assert.match(tag, /\ssrc=/, `${f}: ${tag}`);
});

test("no inline event handler attributes, in pages or in HTML built by scripts", () => {
  for (const f of served) {
    const hits = read(f).match(/[\s"'`]on(click|change|input|submit|load|error|keydown|keyup|focus|blur|mouseover)\s*=\s*["'`\\]/gi) || [];
    assert.deepEqual(hits, [], f);
    assert.doesNotMatch(read(f), /setAttribute\(\s*["']on[a-z]+["']/i, `${f} sets an inline handler`);
    assert.doesNotMatch(read(f), /href\s*=\s*["']javascript:/i, f);
  }
});

test("every data-on-* handler is one legacy-events.js can call, and it can't run arbitrary code", () => {
  const sandbox = { document: { addEventListener() {} }, window: {}, Element: class {}, console };
  vm.runInNewContext(read(join(pub, "legacy-events.js")), sandbox);
  const { parse, handlers } = sandbox.window.EduosLegacyEvents;
  const all = served.map(read).join("\n");
  const used = [...all.matchAll(/data-on-(?:click|change|input|submit)=\\?"([^"]*)"/g)].map(m => m[1]);
  assert.ok(used.length > 50, `found ${used.length} handlers`);
  // Template placeholders become literals: '${id}' a string, a bare ${i} a number.
  const literal = (src) => src.replace(/'\$\{[^}]*\}'/g, "'x'").replace(/\$\{[^}]*\}/g, "1");
  for (const src of used) for (const call of parse(literal(src))) assert.ok(handlers.includes(call.name), call.name);
  for (const bad of ["alert(document.cookie)", "go(location)", "fetch('x').then(go)", "go('a')+1", "constructor.constructor('x')()"])
    assert.throws(() => parse(bad), bad);
});


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caddyFile = readFileSync(path.join(root, "Caddyfile"), "utf8");
const appCspText = readFileSync(path.join(root, "src", "csp.js"), "utf8");

const parseCsp = (header) => Object.fromEntries(
  header.split(";").map(d => d.trim()).filter(Boolean).map(d => {
    const [name, ...values] = d.split(/\s+/);
    return [name, values.sort().join(" ")];
  })
);

function applicationCspHeader() {
  let value;
  helmet({ contentSecurityPolicy: { directives: cspDirectives } })(
    {},
    { setHeader: (name, header) => { if (/^content-security-policy$/i.test(name)) value = header; }, removeHeader() {} },
    () => {}
  );
  return value;
}

test("Caddy CSP matches the application CSP for script restrictions", () => {
  assert.match(appCspText, /scriptSrc:\s*\["'self'"\]/, "app CSP should set script-src 'self'");
  assert.match(appCspText, /scriptSrcAttr:\s*\["'none'"\]/, "app CSP should set script-src-attr 'none'");

  const caddyPolicy = caddyFile.match(/Content-Security-Policy\s+"([^"]+)"/)?.[1] || "";
  assert.ok(caddyPolicy, "Caddyfile should contain a CSP header");

  assert.match(caddyPolicy, /script-src\s+'self'/, "Caddy CSP must set script-src 'self'");
  assert.match(caddyPolicy, /script-src-attr\s+'none'/, "Caddy CSP must set script-src-attr 'none'");
  assert.doesNotMatch(caddyPolicy, /(?:^|;)\s*script-src\s+[^;]*unsafe-inline/i);
  assert.doesNotMatch(caddyPolicy, /(?:^|;)\s*script-src-attr\s+[^;]*unsafe-inline/i);

  const caddyDirectives = parseCsp(caddyPolicy);
  const appDirectives = parseCsp(applicationCspHeader());
  assert.equal(caddyDirectives["script-src"], appDirectives["script-src"], "Caddy and app script-src must match exactly");
  assert.equal(caddyDirectives["script-src-attr"], appDirectives["script-src-attr"], "Caddy and app script-src-attr must match exactly");
  assert.deepEqual(caddyDirectives, appDirectives, "the complete Caddy CSP must match the application CSP");
});
