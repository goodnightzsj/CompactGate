#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
CONFIG_PATH="${COMPACTGATE_CONFIG:-$PROJECT_DIR/compactgate.json}"
HOST="127.0.0.1"
PORT="7865"
RUNTIME_DIR="${RUNTIME_DIR:-$PROJECT_DIR/.codex-tasks/20260602-unified-logs-codex-compression/raw/runtime}"
LAUNCH_LABEL="${COMPACTGATE_RESTART_LABEL:-com.compactgate.restart}"
PID_FILE="$RUNTIME_DIR/compactgate.pid"
STOP_LOG="$RUNTIME_DIR/compactgate.stop.log"

timestamp() {
  date "+%Y-%m-%d %H:%M:%S"
}

resolve_listen_target() {
  local resolved
  resolved="$(
    PROJECT_DIR="$PROJECT_DIR" CONFIG_PATH="$CONFIG_PATH" "$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const projectDir = process.env.PROJECT_DIR;
const rawConfigPath = process.env.CONFIG_PATH;
const configPath = path.isAbsolute(rawConfigPath)
  ? rawConfigPath
  : path.resolve(projectDir, rawConfigPath);

let listen = "127.0.0.1:7865";

try {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (parsed && typeof parsed.listen === "string" && parsed.listen.trim().length > 0) {
    listen = parsed.listen.trim();
  }
} catch {
  // Fall back to the default target when the config is missing or malformed.
}

const index = listen.lastIndexOf(":");
if (index <= 0) {
  process.stdout.write("127.0.0.1\n7865\n");
  process.exit(0);
}

const host = listen.slice(0, index).trim() || "127.0.0.1";
const port = listen.slice(index + 1).trim() || "7865";
process.stdout.write(`${host}\n${port}\n`);
NODE
  )"

  HOST="$(printf '%s\n' "$resolved" | sed -n '1p')"
  PORT="$(printf '%s\n' "$resolved" | sed -n '2p')"
}

resolve_listen_target

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
