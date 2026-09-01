#!/usr/bin/env bash
# Deploy Mantra Desk → mantra.panenka.games (Hetzner panenka-prod).
# Usage: ./scripts/deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${MANTRA_SSH_HOST:-panenka-prod}"
REMOTE="${MANTRA_REMOTE_DIR:-/opt/mantra}"

echo "==> Checkpoint SQLite WAL (local only; prod DB is not overwritten)"
if [[ -f "$ROOT/data/app.db" ]]; then
  sqlite3 "$ROOT/data/app.db" "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;" || true
fi

# Refresh Mantra tour scores + lineups if credentials exist (prod Hetzner often can't reach mantrafootball.org)
if [[ "${SKIP_MANTRA_SYNC:-0}" != "1" ]] && [[ -f "$ROOT/.env" ]] && grep -q '^MANTRA_EMAIL=' "$ROOT/.env" 2>/dev/null; then
  echo "==> Sync Mantra tours (all Live leagues) → data/mantra-tours*.json"
  (cd "$ROOT" && npm run sync:mantra-tours -- --all) || echo "WARN: Mantra tours sync failed (will keep previous JSON if any)"
  echo "==> Sync Mantra lineups (all Live leagues) → data/mantra-lineups*.json"
  (cd "$ROOT" && npm run sync:mantra-lineups -- --all) || echo "WARN: Mantra lineups sync failed"
fi

echo "==> Sync to $HOST:$REMOTE"
RSYNC_EXCLUDES=(
  --exclude node_modules
  --exclude .git
  --exclude .env
  --exclude 'data/app.db'
  --exclude 'data/app.db-shm'
  --exclude 'data/app.db-wal'
  --exclude 'data/*.db-shm'
  --exclude 'data/*.db-wal'
  --exclude 'data/expected11/profile/**/Cache/'
  --exclude 'data/expected11/profile/**/Code Cache/'
  --exclude 'data/expected11/profile/**/GPUCache/'
  --exclude 'data/expected11/chrome-profile/'
  --exclude .DS_Store
  --exclude 'data/app.db.bak*'
  --exclude 'data/mantra/auctions/'
  --exclude 'data/serie-a-xi/'
)
if [[ "${SKIP_MANTRA_SYNC:-0}" == "1" ]]; then
  echo "==> SKIP_MANTRA_SYNC=1 — not overwriting prod Mantra tours/lineups JSON"
  RSYNC_EXCLUDES+=(
    --exclude 'data/mantra-tours*.json'
    --exclude 'data/mantra-lineups*.json'
  )
fi
rsync -az --delete \
  "${RSYNC_EXCLUDES[@]}" \
  "$ROOT/" "$HOST:$REMOTE/"

echo "==> Reuse Google OAuth client from panenka.games"
ssh "$HOST" "set -eu
  set -- \$(docker ps --filter name=panenkagames-web_ --format '{{.Names}}')
  main_web=\${1:-}
  if [[ -n \"\$main_web\" ]]; then
    id64=\$(docker exec \"\$main_web\" node -e 'process.stdout.write(Buffer.from(process.env.AUTH_GOOGLE_ID||\"\").toString(\"base64\"))')
    secret64=\$(docker exec \"\$main_web\" node -e 'process.stdout.write(Buffer.from(process.env.AUTH_GOOGLE_SECRET||\"\").toString(\"base64\"))')
    if [[ -n \"\$id64\" && -n \"\$secret64\" ]]; then
      google_id=\$(printf %s \"\$id64\" | base64 -d)
      google_secret=\$(printf %s \"\$secret64\" | base64 -d)
      umask 077
      printf '\nGOOGLE_CLIENT_ID=%s\nGOOGLE_CLIENT_SECRET=%s\n' \"\$google_id\" \"\$google_secret\" >> \"$REMOTE/.env\"
    fi
  fi"

echo "==> Ensure Caddy site block for mantra.panenka.games"
ssh "$HOST" 'grep -q "mantra.panenka.games" /opt/panenka.games/Caddyfile || cat >> /opt/panenka.games/Caddyfile <<EOF

mantra.panenka.games {
	encode zstd gzip
	reverse_proxy mantra:3081
}
EOF'

echo "==> Build & restart container"
ssh "$HOST" "cd $REMOTE && docker compose build && docker compose up -d"

echo "==> Reload Caddy"
ssh "$HOST" 'cd /opt/panenka.games && docker compose -f docker-compose.prod.yml exec -T caddy caddy reload --config /etc/caddy/Caddyfile'

echo "==> Health"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://mantra.panenka.games/api/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
if [[ "$ok" != "1" ]]; then
  echo "WARN: health not ready after 60s (container may still be compiling tsx)"
fi
curl -fsS -I "https://mantra.panenka.games/" | head -n 8
curl -fsS "https://mantra.panenka.games/api/health"
echo
echo "OK → https://mantra.panenka.games/"
