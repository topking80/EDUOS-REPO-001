EduOS District Edition 32.0.22 — HTTP/2 edge
============================================

Browsers negotiate HTTP/2 only over TLS, so HTTP/2 is delivered by a
TLS-terminating reverse-proxy edge (Caddy) placed in front of the Node app.
The edge speaks HTTP/2 (and HTTP/3) to the browser, serves the static assets
directly, and proxies the dynamic routes to Node over the internal network.

What you get
------------
  browser ⇄ (HTTP/2 + HTTP/3, TLS)  Caddy edge
                                      ├─ /            static assets, served at the edge
                                      ├─ *.svg/.png/… long-cache (immutable) headers
                                      └─ /api,/auth,/health → Node app (HTTP/1.1, internal)

  - One multiplexed HTTP/2 connection instead of many HTTP/1.1 ones — the whole
    asset set (index.html + 15 artwork SVGs/PNGs + JS) loads over a single
    connection with header compression, which is the real page-load win.
  - Static assets never touch the Node event loop; Node handles only dynamic
    API/auth traffic.
  - Automatic HTTPS: a real certificate for your domain, or Caddy's local CA for
    a zero-config localhost demo.

Run it
------
  cp .env.example .env            # set POSTGRES_PASSWORD, real OIDC_* , EDUOS_SITE_ADDRESS
  docker compose --profile edge up --build

  - Without --profile edge: unchanged — app is published directly on :8080 (HTTP/1.1).
  - With --profile edge: Caddy publishes :80/:443 (+:443/udp for HTTP/3) in front.
    EDUOS_SITE_ADDRESS=localhost  → https://localhost (local CA; curl -k / trust the CA)
    EDUOS_SITE_ADDRESS=your.domain → automatic Let's Encrypt certificate

Correctness behind the proxy
----------------------------
  - The compose network is pinned to 172.29.0.0/16 and the app's
    TRUSTED_PROXY_IPS defaults to it, so the app honors the edge's
    X-Forwarded-For / -Proto / -Host (correct per-client rate limiting and
    req.protocol). Session cookies are Secure (NODE_ENV=production) and travel
    over the browser↔edge TLS leg.
  - Single edge, no app code change. The app's own gzip + cache headers (32.0.20)
    still apply on the :8080 path and to proxied dynamic responses; Caddy does
    not double-encode an already-encoded upstream response.

Validated in this sandbox (Caddy 2.8.4, real run — not just config lint)
------------------------------------------------------------------------
  caddy validate (localhost + a production domain) ........ Valid configuration
  caddy fmt .............................................. clean
  docker compose config (default + --profile edge) ....... valid; edge only under the profile
  live edge + stub upstream, curl --http2:
    GET /                     → HTTP/2 200, index.html served at the edge
    GET /assets/*.svg         → HTTP/2 200, cache-control: public, max-age=604800, immutable
                                alt-svc: h3=":443"  (HTTP/3 advertised)
    GET /api/ping             → HTTP/2 200, proxied through to the Node upstream
    GET http://localhost/     → 308 redirect to https://

Not changed: the demonstration-not-production posture, RLS/OIDC/CSRF/audit model,
all 15 artwork assets, and the 130/130 test suite. nginx is a fine alternative if
you prefer it (terminate TLS, `http2 on;`, proxy_pass to the app) — Caddy is
shipped because HTTP/2 + automatic TLS need no extra configuration.
