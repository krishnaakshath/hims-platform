#!/bin/sh
# Entrypoint of the HIMS runner image (Dockerfile). One image, several jobs:
#
#   start (default)   wait for the database, apply migrations (checksummed
#                     runner, idempotent), seed demo data only when
#                     SEED_ON_START=true AND the database is empty (refused in
#                     production unless ALLOW_PRODUCTION_SEED=1), then exec
#                     `next start`.
#   migrate [--status|--dry-run]
#                     wait for the database, run scripts/db/migrate.ts, exit.
#   seed              wait for the database, run the demo seed (src/db/seed.ts),
#                     exit. The seed itself refuses production unless
#                     ALLOW_PRODUCTION_SEED=1 and needs SEED_DEMO_PASSWORD.
#   codes             fetch the WHO ICD-10 (2019) release from who.int and
#                     import it. The ONLY job that uses the internet, and only
#                     when an operator runs it explicitly.
#   anything else     exec'd as given (e.g. `sh`, `npm run db:backup`).
set -eu

cd /app
TSX="node_modules/.bin/tsx"

cmd="${1:-start}"
[ "$#" -gt 0 ] && shift

case "$cmd" in
  start)
    "$TSX" scripts/docker/prestart.ts
    exec node_modules/.bin/next start -H "${HOSTNAME:-0.0.0.0}" -p "${PORT:-3000}"
    ;;
  migrate)
    "$TSX" scripts/docker/prestart.ts --wait-only
    exec "$TSX" scripts/db/migrate.ts "$@"
    ;;
  seed)
    "$TSX" scripts/docker/prestart.ts --wait-only
    exec "$TSX" src/db/seed.ts "$@"
    ;;
  codes)
    "$TSX" scripts/docker/prestart.ts --wait-only
    exec sh scripts/docker/load-who-icd10.sh "$@"
    ;;
  *)
    exec "$cmd" "$@"
    ;;
esac
