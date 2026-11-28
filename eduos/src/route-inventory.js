// SEC-05 (docs/API-ROUTE-INVENTORY.md): every route the EduOS app answers,
// read from Express's own router after registration, so the inventory can't
// drift from the code. Used by test/route-inventory.test.js.
//
// A route's guards are the names of the functions in its chain, in order.
// express-rate-limit middleware is anonymous; it is recognised by its
// resetKey() method and reported as "rateLimit".
const guardName = fn => (typeof fn?.resetKey === "function" ? "rateLimit" : fn?.name || "anonymous");

export function routeInventory(app) {
  const routes = [];
  const middleware = [];
  const walk = stack => {
    for (const layer of stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).filter(m => m !== "_all").map(m => m.toUpperCase()).sort();
        for (const path of [].concat(layer.route.path)) {
          routes.push({ methods, path: String(path), guards: layer.route.stack.map(s => guardName(s.handle)),
            handler: String(layer.route.stack.at(-1).handle) });
        }
      } else if (layer.handle?.stack) walk(layer.handle.stack);
      else middleware.push(layer);
    }
  };
  walk(app.router.stack);
  // Application-level middleware that runs for a path prefix, before any route.
  const appliesTo = prefix => middleware.filter(l => typeof l.match === "function" && l.match(`${prefix}/inventory-probe`) && !l.match("/inventory-other-probe"));
  const coverage = prefix => ({
    rateLimits: appliesTo(prefix).filter(l => typeof l.handle.resetKey === "function").length,
    noStoreDefault: appliesTo(prefix).some(l => l.handle.name === "noStoreByDefault"),
  });
  return { routes, prefixes: Object.fromEntries(["/api", "/auth", "/lti"].map(p => [p, coverage(p)])) };
}
