# ─────────────────────────────────────────────────────────────────────────
# Staxis CUA Service — Dockerfile for Fly.io deployment
#
# Two-stage build:
#   1. Builder: install deps and compile TypeScript
#   2. Runtime: Playwright base image (Chromium pre-installed), copy
#      compiled JS + production deps, run as non-root
#
# Why Playwright base image: bundling Chromium ourselves means a 600MB+
# image. Microsoft's official image has Chromium + system fonts + the
# right glibc baked in, and is the one Playwright tests against.
# ─────────────────────────────────────────────────────────────────────────

# ─── Stage 1: build ──────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Copy package manifest first for layer caching — npm install only re-runs
# when package.json or package-lock.json changes, not on every src edit.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ─── Stage 2: runtime ────────────────────────────────────────────────────
# Playwright's Node 20 image has Chromium + Firefox + WebKit + all system
# deps. We only use Chromium so that's wasted bytes, but keeping the
# official image means we don't have to chase glibc / fontconfig issues.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy AS runtime

WORKDIR /app

# Drop privileges. Playwright image already has a `pwuser` for this.
# All COPY commands use --chown so pwuser can read its own files at
# runtime — without --chown, files land owned by root and pwuser hits
# EACCES on first import. (Bug found in 2026-05-07 review.)
ENV NODE_ENV=production

# Production deps only.
COPY --chown=pwuser:pwuser package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && \
    chown -R pwuser:pwuser /app/node_modules

# Compiled JS from the builder stage.
COPY --chown=pwuser:pwuser --from=builder /app/dist ./dist

# Worker doesn't expose HTTP by default — it's a poller. If we add a
# /healthz endpoint later, expose it here.
# EXPOSE 8080

USER pwuser

# Use exec form so SIGTERM is forwarded directly to node (Fly.io sends
# SIGTERM on deploys; we want graceful shutdown to drain in-flight jobs).
CMD ["node", "dist/index.js"]
