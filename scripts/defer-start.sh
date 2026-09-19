#!/usr/bin/env bash
#
# Arms a safety-net start that fires a few seconds from now, detached from this
# shell. Arm it BEFORE any operation that stops CompactGate — switching the
# LaunchAgent plist, bootout/bootstrap, a rebuild — so a failure in the command
# that was supposed to bring the service back cannot leave it down.
#
# The action is idempotent: it starts the service only when nothing is listening
# on the port. A switch that succeeded is therefore left alone rather than being
# restarted a second time.
#
# Usage: scripts/defer-start.sh [seconds]   (default 15)
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"
CONFIG_PATH="${COMPACTGATE_CONFIG:-$PROJECT_DIR/compactgate.json}"
HOST="127.0.0.1"
PORT="7865"
RUNTIME_DIR="${RUNTIME_DIR:-$PROJECT_DIR/.codex-tasks/20260602-unified-logs-codex-compression/raw/runtime}"
LAUNCH_LABEL="${COMPACTGATE_LAUNCH_LABEL:-compactgate}"
LAUNCH_PLIST="${COMPACTGATE_LAUNCH_PLIST:-${HOME:-}/Library/LaunchAgents/$LAUNCH_LABEL.plist}"
DEFER_LOG="$RUNTIME_DIR/compactgate.defer-start.log"
DELAY="${1:-15}"

source "$(dirname "$SCRIPT_PATH")/service-common.sh"

resolve_listen_target

mkdir -p "$RUNTIME_DIR"

if [[ "${1:-}" == "--fire" ]]; then
  # Detached half. Runs after the caller (and possibly its shell) is gone.
  sleep "$2"

  exec >>"$DEFER_LOG" 2>&1
  echo "[$(timestamp)] Deferred start fired after ${2}s"

  if [[ -n "$(list_listener_pids)" ]]; then
    echo "[$(timestamp)] $HOST:$PORT is already served; nothing to do"
    exit 0
  fi

  echo "[$(timestamp)] No listener on $HOST:$PORT; starting $LAUNCH_LABEL"
  # bootstrap fails harmlessly when the agent is already registered, which is the
  # usual case; RunAtLoad starts it then, and kickstart covers the case where it
  # is registered but stopped.
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_PLIST" 2>/dev/null || true
  launchctl kickstart "gui/$(id -u)/$LAUNCH_LABEL" 2>/dev/null || true

  if wait_for_server 2>/dev/null; then
    echo "[$(timestamp)] Recovered; listening on $HOST:$PORT"
  else
    echo "[$(timestamp)] Still not listening after start attempt"
    tail -n 40 "$RUNTIME_DIR/compactgate.server.log" 2>/dev/null || true
    exit 1
  fi
  exit 0
fi

if ! [[ "$DELAY" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 [seconds]" >&2
  exit 2
fi

# nohup + full redirection + </dev/null, so the watcher outlives this shell and
# is never killed by the terminal going away.
nohup bash "$SCRIPT_PATH" --fire "$DELAY" >>"$DEFER_LOG" 2>&1 </dev/null &

echo "Armed: CompactGate will be checked and started if needed in ${DELAY}s"
echo "Defer log: $DEFER_LOG"
