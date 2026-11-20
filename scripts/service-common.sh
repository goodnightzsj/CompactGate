#!/usr/bin/env bash
# Shared helpers for restart-service.sh and stop-service.sh.
# Sourced, never executed. Callers must define PROJECT_DIR, CONFIG_PATH and NODE_BIN first.

timestamp() {
  date "+%Y-%m-%d %H:%M:%S"
}

# Resolve hostnames once so the health probe and listener check use the same address.
resolve_listen_target() {
  local resolved
  resolved="$(
    PROJECT_DIR="$PROJECT_DIR" CONFIG_PATH="$CONFIG_PATH" "$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import { lookup } from "node:dns/promises";
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
const host = (index > 0 && listen.slice(0, index).trim()) || "127.0.0.1";
const port = (index > 0 && listen.slice(index + 1).trim()) || "7865";
const { address } = await lookup(host.replace(/^\[|\]$/g, ""));
process.stdout.write(`${host}\n${port}\n${address}\n`);
NODE
  )"

  HOST="$(printf '%s\n' "$resolved" | sed -n '1p')"
  PORT="$(printf '%s\n' "$resolved" | sed -n '2p')"
  LISTENER_ADDRESS="$(printf '%s\n' "$resolved" | sed -n '3p')"
  HEALTHCHECK_HOST="$LISTENER_ADDRESS"

  if [[ "$LISTENER_ADDRESS" == "0.0.0.0" ]]; then
    HEALTHCHECK_HOST="127.0.0.1"
  elif [[ "$LISTENER_ADDRESS" == "::" ]]; then
    HEALTHCHECK_HOST="[::1]"
  elif [[ "$LISTENER_ADDRESS" == *:* ]]; then
    HEALTHCHECK_HOST="[$LISTENER_ADDRESS]"
  fi
}

list_listener_pids() {
  case "$LISTENER_ADDRESS" in
    0.0.0.0|::)
      # lsof prints *:port for both wildcard families.
      local family=IPv4
      if [[ "$LISTENER_ADDRESS" == "::" ]]; then family=IPv6; fi
      lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -Fptn 2>/dev/null |
        awk -v family="$family" -v endpoint="n*:$PORT" '/^p/ { pid=substr($0,2) } /^t/ { type=substr($0,2) } $0 == endpoint && type == family { print pid }' || true
      ;;
    *) lsof -nPt "-iTCP@$HEALTHCHECK_HOST:$PORT" -sTCP:LISTEN 2>/dev/null || true ;;
  esac
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

# HEALTHCHECK_RETRIES is the existing total seconds budget; poll every half second.
wait_for_server() {
  local retries="${HEALTHCHECK_RETRIES:-60}"
  local deadline=$((SECONDS + retries))
  local remaining pid label="${1:-}"

  while [[ $SECONDS -lt $deadline ]]; do
    remaining=$((deadline - SECONDS))
    [[ $remaining -gt 0 ]] || return 1
    if curl --noproxy '*' -fsS --connect-timeout "$remaining" --max-time "$remaining" "http://$HEALTHCHECK_HOST:$PORT/api/health" >/dev/null 2>&1; then
      [[ $SECONDS -lt $deadline ]] || return 1
      [[ -n "$label" ]] || return 0
      pid="$(launchctl print "gui/$(id -u)/$label" 2>/dev/null | awk '/^[[:space:]]*pid = / && !seen++ {print $3}')" || pid=""
      if [[ "$pid" =~ ^[1-9][0-9]*$ && "$(list_listener_pids | sort -u)" == "$pid" && $SECONDS -lt $deadline ]]; then
        printf '%s\n' "$pid"
        return 0
      fi
    fi
    if [[ $SECONDS -ge $deadline ]]; then return 1; fi
    sleep 0.5
  done

  return 1
}
