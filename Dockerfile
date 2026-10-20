# Build stage
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ src/

# Production stage
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
WORKDIR /app

# Install production deps as root before switching to non-root user (#177).
# Running npm ci as root ensures the node_modules tree is fully writable during
# install; the cache and symlinks created by npm are owned by root but readable
# by the facilitator user, so no permission issues at runtime.
COPY package*.json ./
RUN npm ci --omit=dev

# #495: production runtime semantics. Without this the image resolves nodeEnv
# to 'development' (src/config.js), so the production-only HSTS header never
# fires and src/server.js loads a stray .env out of the build context. Setting
# it here makes the flag travel with the image instead of depending on the
# orchestrator to inject it.
ENV NODE_ENV=production

RUN addgroup -S facilitator && adduser -S facilitator -G facilitator
USER facilitator

COPY --from=builder /app/src ./src

# #211: scripts/ and migrations/ ship in the image. The image's own entrypoint
# is `node src/server.js` (see CMD below); the deployment runbook additionally
# runs `node scripts/db-migrate.js up` before it (see docs/DEPLOYMENT.md), and
# scripts/db-migrate.js resolves `../migrations` relative to its own location.
# Without both directories the image serves, but can never provision or migrate
# its own schema — every migration command in the runbook fails on a missing path.
COPY --chown=facilitator:facilitator scripts/ ./scripts/
COPY --chown=facilitator:facilitator migrations/ ./migrations/

# HEALTHCHECK is a LIVENESS probe, so it targets /healthz, not /readyz.
# /readyz can fail on a downstream Soroban RPC outage; failing the
# Docker-level check on that would restart-loop the container and make the
# outage worse (a restart cannot fix someone else's RPC). Orchestrator traffic
# gating belongs on GET /readyz, which names the failing dependency.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3402}/healthz || exit 1

EXPOSE 3402
# #495: exec node directly rather than `npm start`. npm would be PID 1 and would
# not forward SIGTERM/SIGINT to the server, so the graceful-shutdown handlers in
# src/server.js (which drain in-flight settlements) never run on an orchestrated
# stop. This is the same command package.json's start script wraps.
CMD ["node", "src/server.js"]
