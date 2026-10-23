#!/usr/bin/env bash
# Start the whole platform on this machine: local Postgres, API (:4040), web (:3030).
# Ctrl+C stops everything. Logs: logs/{db,server,web}.log
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs

pids=()
cleanup() {
  echo "stopping..."
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_port() {
  for _ in $(seq 1 120); do port_open "$1" && return 0; sleep 1; done
  echo "timed out waiting for port $1 (see logs/)"; exit 1
}

if port_open 5432; then
  echo "postgres already running on :5432"
else
  (cd server && node scripts/local-db.mjs) > logs/db.log 2>&1 &
  pids+=($!)
  wait_port 5432
  echo "postgres up on :5432"
fi

(cd server && npm run dev) > logs/server.log 2>&1 &
pids+=($!)
wait_port 4040
echo "api up on http://localhost:4040"

(cd web && npm run dev) > logs/web.log 2>&1 &
pids+=($!)
wait_port 3030
echo "web up on http://localhost:3030  (Ctrl+C to stop)"

wait
