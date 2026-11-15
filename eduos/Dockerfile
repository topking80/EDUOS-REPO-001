# EduOS District Edition — container images.
#   target "app"      (default, production): API + static UI. Contains NO dev tooling.
#   target "devtools" (local evaluation only): adds dev/ (local OIDC provider,
#                     demo seed, webhook sink, smoke test). Never deploy it.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS devtools
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# 32.3.0: src/contrast.js and src/brand-model.js share code with public/.
COPY public ./public
COPY db ./db
COPY dev ./dev
RUN addgroup -S eduos && adduser -S eduos -G eduos && chown -R eduos:eduos /app
USER eduos
CMD ["node","dev/dev-idp.js"]

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS app
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
# Application source (tests, docs, dev tooling and the standalone HTML are excluded).
COPY src ./src
COPY public ./public
COPY db ./db

# The runtime only needs node. Remove the package managers bundled in the base
# image (npm, npx, corepack, yarn): unused here, and their own dependency trees
# carried 10 HIGH CVEs in the 37.4.0 image scan.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Drop root. /var/lib/eduos-node (32.7.0) holds a school node's EDEN identity
# key; it exists in the image so a fresh volume there is owned by eduos.
RUN addgroup -S eduos && adduser -S eduos -G eduos && chown -R eduos:eduos /app \
 && mkdir -p /var/lib/eduos-node && chown eduos:eduos /var/lib/eduos-node && chmod 700 /var/lib/eduos-node
USER eduos

EXPOSE 8080
# Container healthcheck hits the app's DB-backed /health endpoint.
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node","src/server.js"]
