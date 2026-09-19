#!/usr/bin/env bash
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
STOP_LOG="$RUNTIME_DIR/compactgate.stop.log"
# Stop is deliberately transient: a safety-net start is armed before this script
# exits, so a stop that was meant to be a restart (or a maintenance step whose
# follow-up failed) cannot leave the proxy down. Set to 0 for a durable stop.
STOP_AUTO_RESTART_SECONDS="${COMPACTGATE_STOP_AUTO_RESTART_SECONDS:-15}"

source "$(dirname "$SCRIPT_PATH")/service-common.sh"

resolve_listen_target

mkdir -p "$RUNTIME_DIR"
exec > >(tee -a "$STOP_LOG") 2>&1

echo "[$(timestamp)] Stopping CompactGate for $HOST:$PORT"
echo "[$(timestamp)] Project: $PROJECT_DIR"

# Armed before the stop, not after, so that a failure anywhere below cannot
# leave the proxy down: the watcher only starts the service when nothing is
# listening, so a stop that failed simply makes it a no-op.
if [[ "$STOP_AUTO_RESTART_SECONDS" =~ ^[0-9]+$ ]] && [[ "$STOP_AUTO_RESTART_SECONDS" -gt 0 ]]; then
  echo "[$(timestamp)] Arming safety-net start in ${STOP_AUTO_RESTART_SECONDS}s (COMPACTGATE_STOP_AUTO_RESTART_SECONDS=0 to stop for good)"
  bash "$(dirname "$SCRIPT_PATH")/defer-start.sh" "$STOP_AUTO_RESTART_SECONDS"
else
  echo "[$(timestamp)] Auto-restart disabled; this stop is durable"
fi

# Stop, not uninstall. `bootout` would remove the job definition, and RunAtLoad
# means it has to be bootstrapped again before the service works — a stop command
# that silently disables crash recovery until the next login. `kill SIGTERM`
# leaves the agent registered; the KeepAlive{SuccessfulExit:false} rule sees the
# handler's exit 0 in src/server/main.ts as a clean stop and does not relaunch.
#
# To uninstall instead: launchctl bootout gui/$(id -u) "$LAUNCH_PLIST"
echo "[$(timestamp)] Sending SIGTERM to $LAUNCH_LABEL"
if ! launchctl kill SIGTERM "gui/$(id -u)/$LAUNCH_LABEL" 2>/dev/null; then
  echo "[$(timestamp)] $LAUNCH_LABEL is not loaded; nothing to stop"
fi

if wait_for_port_to_close; then
  echo "[$(timestamp)] CompactGate stopped; no listener remains on $HOST:$PORT"
else
  echo "[$(timestamp)] Stop failed; listener still present on $HOST:$PORT"
  exit 1
fi

echo "[$(timestamp)] Stop log: $STOP_LOG"
