#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)}"
HOST="${COMPACTGATE_HOST:-127.0.0.1}"
PORT="${COMPACTGATE_PORT:-7865}"
RUNTIME_DIR="${RUNTIME_DIR:-$PROJECT_DIR/.codex-tasks/20260602-unified-logs-codex-compression/raw/runtime}"
LAUNCH_LABEL="${COMPACTGATE_RESTART_LABEL:-com.compactgate.restart}"
PID_FILE="$RUNTIME_DIR/compactgate.pid"
STOP_LOG="$RUNTIME_DIR/compactgate.stop.log"

timestamp() {
  date "+%Y-%m-%d %H:%M:%S"
}

list_listener_pids() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

wait_for_port_to_close() {
  local deadline=$((SECONDS + 10))

  while [[ $SECONDS -lt $deadline ]]; do
    if [[ -z "$(list_listener_pids)" ]]; then
      return 0
    fi
    sleep 0.2
  done

  return 1
}

mkdir -p "$RUNTIME_DIR"
exec > >(tee -a "$STOP_LOG") 2>&1

echo "[$(timestamp)] Stopping CompactGate for $HOST:$PORT"
echo "[$(timestamp)] Project: $PROJECT_DIR"
echo "[$(timestamp)] Removing launchd job if present: $LAUNCH_LABEL"
launchctl remove "$LAUNCH_LABEL" >/dev/null 2>&1 || true

pids="$(list_listener_pids)"
if [[ -n "$pids" ]]; then
  echo "[$(timestamp)] Stopping listener PID(s): $pids"
  kill $pids 2>/dev/null || true

  if ! wait_for_port_to_close; then
    pids="$(list_listener_pids)"
    if [[ -n "$pids" ]]; then
      echo "[$(timestamp)] Force stopping listener PID(s): $pids"
      kill -9 $pids 2>/dev/null || true
    fi
  fi
else
  echo "[$(timestamp)] No listener found on port $PORT"
fi

if wait_for_port_to_close; then
  rm -f "$PID_FILE"
  echo "[$(timestamp)] CompactGate stopped; no listener remains on $HOST:$PORT"
else
  echo "[$(timestamp)] Stop failed; listener still present on $HOST:$PORT"
  exit 1
fi

echo "[$(timestamp)] Stop log: $STOP_LOG"
