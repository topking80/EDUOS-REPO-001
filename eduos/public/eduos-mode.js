/* EduOS 32.0.53 — demo-mode gate.
 * The persona switcher, guided tour, synthetic sample data and the browser-local
 * Arrival/Transportation walkthrough are demonstrations only. They are shown
 * ONLY when the server reports EDUOS_DEMO_MODE=true via GET /api/app-config.
 * Anything else (production, an error, an old server) fails closed: the demo
 * workspace stays hidden and the authenticated server workspace is shown.
 * Loaded synchronously in <head> so nothing demo-only flashes before the check. */
(function (root) {
  "use strict";
  function modeFromConfig(config) { return config && config.demoMode === true ? "demo" : "production"; }
  var CSS =
    'html:not([data-eduos-mode="demo"]) body>.app,' +
    'html:not([data-eduos-mode="demo"]) #tourBackdrop,' +
    'html:not([data-eduos-mode="demo"]) #eduos-api-toggle{display:none!important}' +
    'html[data-eduos-mode="production"] #eduos-api-data{display:block!important}' +
    '#eduos-demo-banner{display:none}' +
    'html[data-eduos-mode="demo"] #eduos-demo-banner{display:block;position:sticky;top:0;z-index:10002;background:#7a3e00;color:#fff;' +
    'font:700 12px/1.4 system-ui,sans-serif;text-align:center;padding:6px 12px}';
  function apply(doc, mode) {
    doc.documentElement.setAttribute("data-eduos-mode", mode);
    if (mode === "demo" && doc.body && !doc.getElementById("eduos-demo-banner")) {
      var b = doc.createElement("div");
      b.id = "eduos-demo-banner"; b.setAttribute("role", "note");
      b.textContent = "Demo mode: synthetic data only. Persona switching is not sign-in and grants no server access.";
      doc.body.prepend(b);
    }
    return mode;
  }
  function init(doc, fetchImpl) {
    doc.documentElement.setAttribute("data-eduos-mode", "loading");
    var style = doc.createElement("style"); style.id = "eduos-mode-css"; style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
    var p = Promise.resolve()
      .then(function () { return fetchImpl("/api/app-config", { credentials: "same-origin", cache: "no-store" }); })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(modeFromConfig, function () { return "production"; })
      .then(function (mode) {
        if (doc.readyState === "loading") {
          return new Promise(function (resolve) {
            doc.addEventListener("DOMContentLoaded", function () { resolve(apply(doc, mode)); }, { once: true });
          });
        }
        return apply(doc, mode);
      });
    return p;
  }
  var api = { modeFromConfig: modeFromConfig, init: init, CSS: CSS };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && root.document && root.fetch) root.EDUOS_MODE = init(root.document, root.fetch.bind(root));
})(typeof window !== "undefined" ? window : null);
