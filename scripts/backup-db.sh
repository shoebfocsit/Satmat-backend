#!/usr/bin/env bash
# ============================================================
# Backup the SATMAT SQLite database.
# Usage:   bash scripts/backup-db.sh [dest-dir]     (default: backups/)
# Tip: schedule with cron, e.g. daily at 03:00:
#   0 3 * * * cd /opt/satmat/backend && bash scripts/backup-db.sh /opt/satmat/backups >> logs/backup.log 2>&1
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."

[ -f .env ] && { set -a; . ./.env; set +a; }
[ -n "${DATABASE_URL:-}" ] || { echo "ERROR: DATABASE_URL not set (backend/.env)"; exit 1; }

DB_PATH="${DATABASE_URL#file:}"
[ -f "$DB_PATH" ] || { echo "ERROR: DB file not found: $DB_PATH"; exit 1; }

DEST_DIR="${1:-backups}"
mkdir -p "$DEST_DIR"
OUT="${DEST_DIR}/satmat-$(date +%Y%m%d-%H%M%S).db"

if command -v sqlite3 >/dev/null 2>&1; then
  # Safe online backup (consistent even while the app is writing)
  sqlite3 "$DB_PATH" ".backup '${OUT}'"
else
  # Fallback: copy the DB plus WAL/SHM sidecar files if present
  cp "$DB_PATH" "$OUT"
  [ -f "${DB_PATH}-wal" ] && cp "${DB_PATH}-wal" "${OUT}-wal" || true
  [ -f "${DB_PATH}-shm" ] && cp "${DB_PATH}-shm" "${OUT}-shm" || true
fi

echo "==> Backup written: ${OUT}"
