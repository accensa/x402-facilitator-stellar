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

RUN addgroup -S facilitator && adduser -S facilitator -G facilitator
USER facilitator

COPY --from=builder /app/src ./src

# HEALTHCHECK is a LIVENESS probe, so it targets /healthz, not /health/ready.
# /health/ready can fail on a downstream Soroban RPC outage; failing the
# Docker-level check on that would restart-loop the container and make the
# outage worse (a restart cannot fix someone else's RPC). Orchestrator traffic
# gating belongs on GET /health/ready, which names the failing dependency.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3402}/healthz || exit 1

EXPOSE 3402
CMD ["npm", "start"]
