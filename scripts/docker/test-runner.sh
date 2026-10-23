#!/bin/sh
# In-Docker test runner (Dockerfile target `test`, compose profile `test`):
#
#   docker compose --profile test run --rm test                       # whole suite
#   docker compose --profile test run --rm test tests/lib/brand       # a subset
#   docker compose --profile test run --rm test tests/api/health.test.ts -t "blob"
#
# Arguments are passed to `vitest run`. Tests use a throwaway database
# (TEST_DATABASE_NAME, default hims_test) in the compose postgres service,
# created here when missing, migrated and seeded with the demo data. The app's
# own database is never touched: this script refuses to run against it.
set -eu
cd /app

DB_NAME="${TEST_DATABASE_NAME:-hims_test}"
case "$DB_NAME" in
  hims) echo "[test] refusing: TEST_DATABASE_NAME must not be the app database (hims)" >&2; exit 64 ;;
  *[!a-z0-9_]*|'') echo "[test] TEST_DATABASE_NAME must match [a-z0-9_]+" >&2; exit 64 ;;
esac

: "${PGHOST:=postgres}" "${PGPORT:=5432}" "${PGUSER:=postgres}"
export PGHOST PGPORT PGUSER PGPASSWORD

i=0
until pg_isready -q -d postgres; do
  i=$((i + 1))
  [ "$i" -ge 60 ] && { echo "[test] database not reachable" >&2; exit 1; }
  sleep 2
done

if [ "$(psql -d postgres -tAc "select 1 from pg_database where datname = '$DB_NAME'")" != "1" ]; then
  echo "[test] creating database $DB_NAME"
  psql -q -d postgres -c "create database $DB_NAME"
fi

export DATABASE_URL="postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${DB_NAME}"

node_modules/.bin/tsx scripts/db/migrate.ts
if [ "${TEST_SKIP_SEED:-}" != "1" ]; then
  node_modules/.bin/tsx src/db/seed.ts
fi

exec node_modules/.bin/vitest run "$@"
