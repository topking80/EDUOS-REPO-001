// Prints the route inventory of the EduOS app as JSON (SEC-05). Run in a
// child process per EDUOS_NODE_TIER, because routes depend on the tier and
// config is read once at import. Nothing connects to a database or listens.
process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/eduos_test";
process.env.PUBLIC_ORIGIN ||= "http://localhost:8080";
process.env.OIDC_ISSUER ||= "https://identity.example.test";
process.env.OIDC_CLIENT_ID ||= "eduos-test";
process.env.OIDC_CLIENT_SECRET ||= "test-secret";
process.env.OIDC_REDIRECT_URI ||= "http://localhost:8080/auth/callback";
const { app } = await import("../../src/server.js");
const { routeInventory } = await import("../../src/route-inventory.js");
process.stdout.write(JSON.stringify(routeInventory(app)), () => process.exit(0));
