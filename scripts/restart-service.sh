#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
CONFIG_PATH="${COMPACTGATE_CONFIG:-$PROJECT_DIR/compactgate.json}"
HOST="127.0.0.1"
PORT="7865"
HEALTHCHECK_HOST="$HOST"
BUILD_BEFORE_RESTART="${COMPACTGATE_RESTART_BUILD:-1}"
RESTART_DELAY_SECONDS="${COMPACTGATE_RESTART_DELAY_SECONDS:-0.25}"
RUNTIME_DIR="${RUNTIME_DIR:-$PROJECT_DIR/.codex-tasks/20260602-unified-logs-codex-compression/raw/runtime}"
LAUNCH_LABEL="${COMPACTGATE_RESTART_LABEL:-com.compactgate.restart}"
PID_FILE="$RUNTIME_DIR/compactgate.pid"
RESTART_LOG="$RUNTIME_DIR/compactgate.restart.log"
SERVER_LOG="$RUNTIME_DIR/compactgate.server.log"
RUNNER_SCRIPT="$RUNTIME_DIR/compactgate-runner.sh"

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
  HEALTHCHECK_HOST="$HOST"

  if [[ "$HEALTHCHECK_HOST" == "0.0.0.0" || "$HEALTHCHECK_HOST" == "::" || "$HEALTHCHECK_HOST" == "[::]" ]]; then
    HEALTHCHECK_HOST="127.0.0.1"
  fi
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

start_server() {
  cat >"$RUNNER_SCRIPT" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
cd "$PROJECT_DIR"
exec env \
  -u COMPACTGATE_LOG_DB \
  COMPACTGATE_CONFIG="$CONFIG_PATH" \
  NODE_ENV=production \
  PATH="$PATH" \
  HTTPS_PROXY="${HTTPS_PROXY:-}" \
  https_proxy="${https_proxy:-}" \
  HTTP_PROXY="${HTTP_PROXY:-}" \
  http_proxy="${http_proxy:-}" \
  NO_PROXY="${NO_PROXY:-}" \
  no_proxy="${no_proxy:-}" \
  "$NODE_BIN" dist/server/main.js
RUNNER
  chmod +x "$RUNNER_SCRIPT"

  launchctl submit \
    -l "$LAUNCH_LABEL" \
    -o "$SERVER_LOG" \
    -e "$SERVER_LOG" \
    -- "$RUNNER_SCRIPT"
}

stop_launch_job() {
  echo "[$(timestamp)] Removing launchd job if present: $LAUNCH_LABEL"
  launchctl remove "$LAUNCH_LABEL" >/dev/null 2>&1 || true
}

wait_for_server() {
  local deadline=$((SECONDS + 15))

  while [[ $SECONDS -lt $deadline ]]; do
    if curl -fsS "http://$HEALTHCHECK_HOST:$PORT/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done

  return 1
}

build_dist() {
  local tsc_bin="$PROJECT_DIR/node_modules/.bin/tsc"
  local vite_bin="$PROJECT_DIR/node_modules/.bin/vite"

  if [[ ! -x "$tsc_bin" || ! -x "$vite_bin" ]]; then
    echo "[$(timestamp)] Missing local build tools. Run npm install first."
    exit 1
  fi

  "$tsc_bin" -p tsconfig.json
  "$tsc_bin" -p tsconfig.server.json
  "$vite_bin" build
}

restart_worker() {
  mkdir -p "$RUNTIME_DIR"

  exec >>"$RESTART_LOG" 2>&1
  trap 'echo "[$(timestamp)] Restart worker failed near line $LINENO with exit code $?"; tail -n 80 "$SERVER_LOG" 2>/dev/null || true' ERR

  echo "[$(timestamp)] Restart worker started for $HOST:$PORT"
  echo "[$(timestamp)] Project: $PROJECT_DIR"

  cd "$PROJECT_DIR"
  if [[ ! -f "$PROJECT_DIR/dist/server/main.js" ]]; then
    echo "[$(timestamp)] Missing dist/server/main.js and COMPACTGATE_RESTART_BUILD=0"
    exit 1
  fi

  sleep "$RESTART_DELAY_SECONDS"
  stop_launch_job

  local pids
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
    echo "[$(timestamp)] No existing listener found"
  fi

  echo "[$(timestamp)] Starting CompactGate"
  start_server

  if wait_for_server; then
    pids="$(list_listener_pids)"
    printf "%s\n" "$pids" | head -n 1 >"$PID_FILE"
    echo "[$(timestamp)] Restart complete; PID $(cat "$PID_FILE") is listening on $HOST:$PORT via $LAUNCH_LABEL"
  else
    echo "[$(timestamp)] Restart failed; server did not become healthy"
    tail -n 80 "$SERVER_LOG" || true
    exit 1
  fi
}

if [[ "${1:-}" == "--worker" ]]; then
  restart_worker
  exit 0
fi

mkdir -p "$RUNTIME_DIR"

if [[ "$BUILD_BEFORE_RESTART" != "0" ]]; then
  echo "Building CompactGate before scheduling restart..."
  {
    echo "[$(timestamp)] Building before scheduling restart"
    build_dist
    echo "[$(timestamp)] Build complete; scheduling restart worker"
  } >>"$RESTART_LOG" 2>&1
else
  echo "Skipping build before restart."
fi

if command -v setsid >/dev/null 2>&1; then
  setsid env \
    PROJECT_DIR="$PROJECT_DIR" \
    COMPACTGATE_HOST="$HOST" \
    COMPACTGATE_PORT="$PORT" \
    COMPACTGATE_RESTART_BUILD=0 \
    COMPACTGATE_RESTART_DELAY_SECONDS="$RESTART_DELAY_SECONDS" \
    RUNTIME_DIR="$RUNTIME_DIR" \
    NODE_BIN="$NODE_BIN" \
    PATH="$PATH" \
    HTTPS_PROXY="${HTTPS_PROXY:-}" \
    https_proxy="${https_proxy:-}" \
    HTTP_PROXY="${HTTP_PROXY:-}" \
    http_proxy="${http_proxy:-}" \
    NO_PROXY="${NO_PROXY:-}" \
    no_proxy="${no_proxy:-}" \
    bash "$SCRIPT_PATH" --worker >>"$RESTART_LOG" 2>&1 </dev/null &
else
  nohup env \
    PROJECT_DIR="$PROJECT_DIR" \
    COMPACTGATE_HOST="$HOST" \
    COMPACTGATE_PORT="$PORT" \
    COMPACTGATE_RESTART_BUILD=0 \
    COMPACTGATE_RESTART_DELAY_SECONDS="$RESTART_DELAY_SECONDS" \
    RUNTIME_DIR="$RUNTIME_DIR" \
    NODE_BIN="$NODE_BIN" \
    PATH="$PATH" \
    HTTPS_PROXY="${HTTPS_PROXY:-}" \
    https_proxy="${https_proxy:-}" \
    HTTP_PROXY="${HTTP_PROXY:-}" \
    http_proxy="${http_proxy:-}" \
    NO_PROXY="${NO_PROXY:-}" \
    no_proxy="${no_proxy:-}" \
    bash "$SCRIPT_PATH" --worker >>"$RESTART_LOG" 2>&1 </dev/null &
fi

echo "Scheduled CompactGate restart for http://$HOST:$PORT"
echo "Build before restart: $BUILD_BEFORE_RESTART"
echo "Restart delay seconds: $RESTART_DELAY_SECONDS"
echo "Launch label: $LAUNCH_LABEL"
echo "Restart log: $RESTART_LOG"
echo "Server log: $SERVER_LOG"
