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
RUNTIME_DIR="${RUNTIME_DIR:-$PROJECT_DIR/.codex-tasks/20260602-unified-logs-codex-compression/raw/runtime}"
LAUNCH_LABEL="${COMPACTGATE_LAUNCH_LABEL:-compactgate}"
LAUNCH_PLIST="${COMPACTGATE_LAUNCH_PLIST:-${HOME:-}/Library/LaunchAgents/$LAUNCH_LABEL.plist}"
HEALTHCHECK_RETRIES="${COMPACTGATE_HEALTHCHECK_RETRIES:-60}"
RESTART_LOG="$RUNTIME_DIR/compactgate.restart.log"
SERVER_LOG="$RUNTIME_DIR/compactgate.server.log"

source "$(dirname "$SCRIPT_PATH")/service-common.sh"

resolve_listen_target

# Absolute paths are baked into the plist because launchd has no shell: it does
# not read PATH from a profile and cannot see nvm. The script's job shrinks to
# keeping those values in sync with this checkout.
install_agent() {
  if [[ ! -f "$LAUNCH_PLIST" ]]; then
    echo "[$(timestamp)] Missing LaunchAgent: $LAUNCH_PLIST" >&2
    echo "Install it once with:" >&2
    echo "  cp $PROJECT_DIR/scripts/$LAUNCH_LABEL.plist $LAUNCH_PLIST" >&2
    exit 1
  fi

  local node_bin plist_launcher plist_node
  node_bin="$(command -v "$NODE_BIN" || true)"
  # ProgramArguments is [launcher, node, main.js]: the launcher is the execv shim
  # that exists so BTM names this service "compactgate" instead of "node", so the
  # node path to check lives at index 1, not 0.
  plist_launcher="$(plutil -extract ProgramArguments.0 raw "$LAUNCH_PLIST")"
  plist_node="$(plutil -extract ProgramArguments.1 raw "$LAUNCH_PLIST")"
  if [[ ! -x "$plist_launcher" ]]; then
    echo "[$(timestamp)] Launcher missing or not executable: $plist_launcher" >&2
    echo "Rebuild it with: npm run build:launcher" >&2
    exit 1
  fi
  if [[ -n "$node_bin" && "$node_bin" != "$plist_node" ]]; then
    echo "[$(timestamp)] Node moved: plist has $plist_node, this shell uses $node_bin" >&2
    echo "Update ProgramArguments in $LAUNCH_PLIST and re-run." >&2
    exit 1
  fi

  # `launchctl bootstrap` exits non-zero when the service is already bootstrapped,
  # which is the normal case on a restart.
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_PLIST" 2>/dev/null || true
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

  install_agent

  # `kickstart -k` kills the running instance and starts a fresh one, in that
  # order, inside launchd — so there is no window where the job is half-torn-down.
  # The old `remove` + `submit` pair had exactly that window, and a submit landing
  # in it exits 0 while starting nothing, which is how this service used to come
  # back up dead after a restart.
  echo "[$(timestamp)] Kickstarting $LAUNCH_LABEL"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCH_LABEL"

  if wait_for_server; then
    local pid
    pid="$(launchctl print "gui/$(id -u)/$LAUNCH_LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}')"
    echo "[$(timestamp)] Restart complete; PID ${pid:-unknown} is listening on $HOST:$PORT via $LAUNCH_LABEL"
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
  } 2>&1 | tee -a "$RESTART_LOG"
else
  echo "Skipping build before restart."
fi

LAUNCHER="$(command -v setsid || echo nohup)"

export PROJECT_DIR RUNTIME_DIR NODE_BIN

"$LAUNCHER" bash "$SCRIPT_PATH" --worker >>"$RESTART_LOG" 2>&1 </dev/null &

echo "Scheduled CompactGate restart for http://$HOST:$PORT"
echo "Build before restart: $BUILD_BEFORE_RESTART"
echo "Launch label: $LAUNCH_LABEL"
echo "Launch plist: $LAUNCH_PLIST"
echo "Restart log: $RESTART_LOG"
echo "Server log: $SERVER_LOG"
