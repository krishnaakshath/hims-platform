#!/bin/sh
# `docker compose --profile codes run --rm codes` (or: npm run docker:codes)
#
# Downloads the official WHO ICD-10 (2019) ClaML release from who.int
# (scripts/code-systems/fetch-who-icd10.ts: https on who.int hosts only, prints
# the SHA-256), converts it, and imports it as the icd10 code set
# "WHO-2019" into the database. This is the ONLY part of the Docker deployment
# that uses the internet, and it runs only when an operator starts it.
#
# Offline alternative: put the release file on the host and pass it in:
#   docker compose --profile codes run --rm -v /path/icd102019en.xml.zip:/in/who.zip:ro codes --file /in/who.zip
# Extra arguments go to the fetch step (--url <who.int url> | --file <path>).
# CODES_BY names the operator in the import record (default "docker codes job").
set -eu
cd /app
TSX="node_modules/.bin/tsx"

# The fetch tool refuses NODE_ENV=production (it is an operator tool, not app
# code); this explicit job is the sanctioned way to run it in the container.
NODE_ENV=development "$TSX" scripts/code-systems/fetch-who-icd10.ts "$@"

"$TSX" scripts/import-code-system.ts \
  --file data/code-systems/who-icd10-2019.csv \
  --kind icd10 \
  --version WHO-2019 \
  --name "WHO ICD-10 (2019)" \
  --licence "WHO ICD-10 (2019), downloaded $(date -u +%Y-%m-%d)" \
  --by "${CODES_BY:-docker codes job}" \
  ${CODES_IMPORT_ARGS:-}
