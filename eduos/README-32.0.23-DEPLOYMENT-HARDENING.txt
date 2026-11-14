EduOS District Edition 32.0.23 — Edge deployment hardening
=========================================================

Changes
-------
- Removed the published Node :8080 port. The API is no longer directly reachable
  from the host when using this deployment topology; public ingress is Caddy.
- Split the compose topology into an internal backend network (database + app)
  and a dedicated edge network (Caddy + app).
- Restricted the default trusted-proxy range to the dedicated edge subnet
  172.30.0.0/24 instead of the entire application/database network.
- Removed the immutable cache directive from non-content-hashed asset names.
  Assets now use a one-hour cache with must-revalidate; HTML remains no-cache.
- Missing static asset requests are served as 404 rather than falling back to
  the SPA index document.
- Preserved existing project artwork and application source.

Run
---
cp .env.example .env
# Set a strong POSTGRES_PASSWORD and real OIDC configuration.
docker compose --profile edge up --build

The edge profile is now the supported public deployment path. The Node service
has no host-published port. For local API debugging, use `docker compose exec app`
or an explicitly isolated development override; do not publish the production
container port.

Limitations
-----------
This is a configuration/source hardening change. It does not certify production
readiness, FERPA/COPPA compliance, or a live deployment. Validate the Caddy
configuration and compose topology with Docker/Caddy in the target environment.
