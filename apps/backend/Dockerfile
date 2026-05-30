# syntax=docker/dockerfile:1

# Build context must be the REPO ROOT (pnpm monorepo needs the root
# lockfile + workspace manifest), e.g.:
#   docker build -f apps/backend/Dockerfile -t expenser-backend .

# ---- Base: shared runtime image -------------------------------------------
FROM node:24-slim AS base
# openssl is required by Prisma's query engine at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# ---- Build: install all deps, generate Prisma client, compile -------------
FROM base AS build
# Toolchain needed to compile native modules (bcrypt) when no prebuilt
# binary is available for this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install with the full workspace so the lockfile resolves correctly.
# Every workspace package.json must be present for --frozen-lockfile to
# validate, even though --filter scopes the actual install to the backend.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/webapp/package.json apps/webapp/package.json
RUN pnpm install --filter @expenser/backend... --frozen-lockfile

# Bring in the backend source and build it.
COPY apps/backend apps/backend
RUN pnpm --filter @expenser/backend exec prisma generate
RUN pnpm --filter @expenser/backend build

# Produce a self-contained, prod-only deployment of just the backend.
# --legacy is required by pnpm v10 to deploy non-injected workspaces.
RUN pnpm --filter=@expenser/backend --legacy deploy --prod /prod/backend
# Re-generate the Prisma client *inside* the pruned deployment so the
# generated client + engine binary are present in its node_modules.
RUN pnpm --filter @expenser/backend exec prisma generate \
  --schema=/prod/backend/prisma/schema.prisma

# ---- Runner: minimal image with only what's needed to run ----------------
FROM base AS runner
ENV NODE_ENV=production
# Cloud Run injects PORT (defaults to 8080); server.ts reads process.env.PORT.
ENV PORT=8080

# Run as the unprivileged user that ships with the node image.
COPY --from=build --chown=node:node /prod/backend /app
USER node

EXPOSE 8080
CMD ["node", "dist/server.js"]
