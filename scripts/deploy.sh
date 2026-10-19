#!/usr/bin/env bash
# ============================================================
# SATMAT backend — one-shot deploy/update (Hostinger KVM: PM2 + Node + SQLite)
# Run from anywhere:   bash scripts/deploy.sh
# Re-runnable: safe to run on every git pull / update.
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."   # -> backend/
echo "==> Deploying SATMAT backend from $(pwd)"

command -v node >/dev/null || { echo "ERROR: node not found — install Node.js 20"; exit 1; }
command -v npm  >/dev/null || { echo "ERROR: npm not found"; exit 1; }
command -v pm2  >/dev/null || { echo "ERROR: pm2 not found — run: npm i -g pm2"; exit 1; }
[ -f .env ] || { echo "ERROR: backend/.env missing — copy .env.production.example to .env and fill it"; exit 1; }

# Load env (DATABASE_URL, PORT) for this script
set -a; . ./.env; set +a

# --- Validate required secrets up front (fail fast with a clear message) ---
missing=0
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  echo "ERROR: ADMIN_PASSWORD is empty in .env — this is the SUPER_ADMIN login password (>=8 chars)."
  missing=1
fi
if [ -z "${JWT_SECRET:-}" ] || [ "${#JWT_SECRET}" -lt 32 ] || [[ "${JWT_SECRET:-}" == *change-me* ]]; then
  echo "ERROR: JWT_SECRET must be a random >=32-char value (generate: openssl rand -base64 48)."
  missing=1
fi
if [ -z "${JWT_REFRESH_SECRET:-}" ] || [ "${#JWT_REFRESH_SECRET}" -lt 32 ] || [[ "${JWT_REFRESH_SECRET:-}" == *change-me* ]]; then
  echo "ERROR: JWT_REFRESH_SECRET must be a random >=32-char value (generate: openssl rand -base64 48)."
  missing=1
fi
if [ "$missing" -eq 1 ]; then
  echo "==> Fix backend/.env (see .env.production.example) then re-run: bash scripts/deploy.sh"
  exit 1
fi

# Ensure the SQLite data directory exists (DATABASE_URL should use an absolute
# path outside the app dir, e.g. file:/opt/satmat/data/satmat.db)
if [[ "${DATABASE_URL:-}" == file:* ]]; then
  DB_PATH="${DATABASE_URL#file:}"
  DB_DIR="$(dirname "$DB_PATH")"
  if [ "$DB_DIR" != "." ] && [ ! -d "$DB_DIR" ]; then
    echo "==> creating SQLite data dir: $DB_DIR"
    mkdir -p "$DB_DIR" 2>/dev/null || sudo mkdir -p "$DB_DIR"
  fi
fi

# devDependencies (nest CLI, typescript, ts-node, prisma) are required for
# build/migrate/seed, and npm omits them when NODE_ENV=production — force include.
echo "==> npm ci --include=dev"
npm ci --include=dev

echo "==> npm run build (prisma generate + nest build)"
npm run build

echo "==> prisma migrate deploy"
npx prisma migrate deploy

echo "==> db:seed (reference data + admin)"
npm run db:seed

mkdir -p logs
if pm2 describe satmat-backend >/dev/null 2>&1; then
  echo "==> pm2 reload satmat-backend --update-env"
  pm2 reload satmat-backend --update-env
else
  echo "==> pm2 start ecosystem.config.js --env production"
  pm2 start ecosystem.config.js --env production
fi
pm2 save

echo "==> Done. Health check: curl -fsS http://127.0.0.1:${PORT:-8080}/health"
