#!/usr/bin/env bash
# Run Prisma migrations against production database.
# Usage: DIRECT_URL="postgresql://..." DATABASE_URL="postgresql://..." bash scripts/migrate-prod.sh
#
# Railway note: DATABASE_URL uses the connection pooler (pgbouncer).
# DIRECT_URL must be the direct (non-pooled) connection for migrations.
# Both are available in the Railway Postgres plugin variables.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]] || [[ -z "${DIRECT_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL and DIRECT_URL must both be set" >&2
  exit 1
fi

echo "Running Prisma migrate deploy against production..."
pnpm --filter @autmn/db exec prisma migrate deploy

echo "Done. Current migration status:"
pnpm --filter @autmn/db exec prisma migrate status
