# HIMS container image. Docker-only deployment: the app, its one-shot jobs
# (migrate, seed, codes) and the in-Docker test runner all come from this file.
#
#   runner (default target)  production app: `next start` as a non-root user,
#                            plus the TypeScript ops scripts (migrations,
#                            seed, backup/restore-check, code-set import) run
#                            through tsx, and the PostgreSQL client tools.
#   test                     full dev dependencies + tests/, for
#                            `docker compose --profile test run --rm test`.
#
# The build needs only the npm registry (fonts ship in the `geist` package;
# no Google Fonts fetch). Nothing in the image reaches the internet at run time.
ARG NODE_IMAGE=node:22-alpine
# Same image as the compose `postgres` service: its client tools match the server.
ARG POSTGRES_IMAGE=postgres:15-alpine

FROM ${POSTGRES_IMAGE} AS pgtools

FROM ${NODE_IMAGE} AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat
ENV NEXT_TELEMETRY_DISABLED=1

# Every dependency (build tooling, tests).
FROM base AS deps
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=20000

# Runtime dependencies only (tsx is a runtime dependency: the ops scripts).
# Pruned from the full install: one registry download per build.
FROM deps AS prod-deps
RUN npm prune --omit=dev --no-audit --no-fund

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `next build` connects to nothing: no database, Redis or file store calls happen
# at build time, and no secrets are needed.
RUN npm run build

# In-Docker test runner (profile `test`). Tests run against a throwaway
# database (hims_test) in the compose postgres service, never the app's own.
FROM deps AS test
# openssl: tests generate throwaway certificates (tests/helpers/selfsigned.ts)
RUN apk add --no-cache postgresql17-client openssl
COPY . .
ENV NODE_ENV=test
ENTRYPOINT ["sh", "scripts/docker/test-runner.sh"]

FROM base AS runner
# PostgreSQL client tools for db:backup and db:restore-check. Alpine has no
# 15 client package, and pg_restore 17 emits `SET transaction_timeout`, which a
# 15 server rejects; so the 15 binaries are copied from the server image
# (same Alpine release) and run on the system libpq that postgresql17-client
# pulls in (libpq.so.5 is backward compatible). PG_BIN_DIR selects them.
# unzip for the WHO ICD-10 loader, tini as PID 1 (signals, zombie reaping).
RUN apk add --no-cache postgresql17-client libedit unzip tini
COPY --from=pgtools /usr/local/bin/pg_dump /usr/local/bin/pg_restore /usr/local/bin/psql /usr/local/bin/pg_isready /opt/pg15/bin/
ENV NODE_ENV=production \
    PG_BIN_DIR=/opt/pg15/bin \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    BLOB_LOCAL_DIR=/app/data/blobs
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --chown=node:node package.json package-lock.json next.config.ts tsconfig.json drizzle.config.ts ./
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src
# The local file store (mounted as the hims_blobs volume) and the code-set
# work directory, both writable by the non-root user.
RUN mkdir -p /app/data/blobs /app/data/code-systems && chown -R node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.json()).then(b=>process.exit(b.checks&&b.checks.database==='ok'?0:1),()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--", "sh", "/app/scripts/docker-entrypoint.sh"]
CMD ["start"]
