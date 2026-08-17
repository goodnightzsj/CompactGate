#!/usr/bin/env bash
# Shared helpers for restart-service.sh and stop-service.sh.
# Sourced, never executed. Callers must define PROJECT_DIR, CONFIG_PATH and NODE_BIN first.

timestamp() {
  date "+%Y-%m-%d %H:%M:%S"
}

# Sets HOST, PORT and HEALTHCHECK_HOST from the configured listen target.
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
