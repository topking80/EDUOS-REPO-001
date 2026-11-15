// Finding 14: demo persona UI and the Arrival/Transportation walkthrough are
// shown only when the server explicitly enables demo mode. Executes the real
// public/eduos-mode.js against a minimal DOM stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// eduos-mode.js is a classic browser script; load it like a CommonJS module.
const sandbox = { module: { exports: {} }, Promise };
vm.runInNewContext(readFileSync(new URL("../public/eduos-mode.js", import.meta.url), "utf8"), sandbox);
const mode = sandbox.module.exports;
const html = (readFileSync(new URL("../public/index.html", import.meta.url), "utf8")+readFileSync(new URL("../public/legacy-app.js", import.meta.url), "utf8"));
const bridge = readFileSync(new URL("../public/api-bridge.js", import.meta.url), "utf8");

function fakeDocument() {
  const attrs = {}, children = [], byId = {};
  const mk = tag => ({ tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, set id(v) { this._id = v; byId[v] = this; }, get id() { return this._id; } });
  return {
    readyState: "complete", attrs, children, byId,
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, appendChild: c => children.push(c) },
    head: { appendChild: c => children.push(c) },
    body: { prepend: c => children.unshift(c) },
    createElement: mk, getElementById: id => byId[id] || null, addEventListener() {}
  };
}
const respond = body => async () => ({ ok: true, json: async () => body });

test("demo mode only when the server says demoMode === true", async () => {
  const doc = fakeDocument();
  assert.equal(await mode.init(doc, respond({ demoMode: true })), "demo");
  assert.equal(doc.attrs["data-eduos-mode"], "demo");
  assert.ok(doc.byId["eduos-demo-banner"], "demo banner shown");
});

test("production, malformed config, HTTP errors and network failures all fail closed", async () => {
  for (const fetchImpl of [respond({ demoMode: false }), respond({ demoMode: "true" }), respond(null),
    async () => ({ ok: false, json: async () => ({ demoMode: true }) }), async () => { throw new Error("offline"); }]) {
    const doc = fakeDocument();
    assert.equal(await mode.init(doc, fetchImpl), "production");
    assert.equal(doc.attrs["data-eduos-mode"], "production");
    assert.equal(doc.byId["eduos-demo-banner"], undefined);
  }
});

test("CSS hides the demo workspace, tour and toggle unless demo mode", () => {
  assert.match(mode.CSS, /html:not\(\[data-eduos-mode="demo"\]\) body>\.app/);
  assert.match(mode.CSS, /#tourBackdrop/);
  assert.match(mode.CSS, /html\[data-eduos-mode="production"\] #eduos-api-data\{display:block!important\}/);
});

test("the gate loads in <head> before any demo markup", () => {
  const head = html.slice(0, html.indexOf("<body"));
  assert.match(head, /<script src="\/eduos-mode\.js"><\/script>/);
  // The arrival walkthrough lives inside the gated demo workspace.
  assert.ok(html.indexOf('<div class="app">') < html.indexOf("const ARRIVAL_KEY"));
});

test("the access-request form offers only grantable permissions (finding 23)", () => {
  const options = [...bridge.matchAll(/<option value="([a-z_]+:[a-z_]+)"/g)].map(m => m[1]);
  assert.deepEqual(options, ["schools:update"]);
});
