import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";

it.each([
  ["127.0.0.1", "127.0.0.1", "41"],
  ["::1", "[::1]", "42"],
  ["0.0.0.0", "127.0.0.1", "43"],
  ["::", "[::1]", "44"]
])("selects only the configured listener when several addresses share a port (%s)", (address, probe, pid) => {
  const script = [
    'source "$1"',
    'lsof() { case " $* " in',
    '  *" -iTCP@127.0.0.1:8080 "*) echo 41 ;;',
    '  *" -iTCP@[::1]:8080 "*) echo 42 ;;',
    '  *" -Fptn "*) printf "%s\\n" p41 tIPv4 n127.0.0.1:8080 p42 tIPv6 "n[::1]:8080" p43 tIPv4 "n*:8080" p44 tIPv6 "n*:8080" ;;',
    '  *) printf "%s\\n" 41 42 43 44 ;;',
    'esac; }',
    'list_listener_pids'
  ].join("\n");
  const result = spawnSync("/bin/bash", ["-c", script, "fixture", path.resolve("scripts/service-common.sh")], {
    env: { ...process.env, PORT: "8080", LISTENER_ADDRESS: address, HEALTHCHECK_HOST: probe }, encoding: "utf8"
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(pid);
});

it.each([["", "42", false], ["41", "42", false], ["42", "42", true]] as const)(
  "checks the job PID %s against listener %s before reporting ready", (job, listener, ready) => {
    const script = [
      'source "$1"', 'job="$2"; listener="$3"', 'SECONDS=0',
      'curl() { return 0; }', 'launchctl() { printf "pid = %s\n" "$job"; }',
      'list_listener_pids() { printf "%s\n" "$listener"; }', 'sleep() { SECONDS=10; }',
      'wait_for_server fixture'
    ].join("\n");
    const result = spawnSync("/bin/bash", ["-c", script, "fixture", path.resolve("scripts/service-common.sh"), job, listener], {
      env: { ...process.env, HEALTHCHECK_HOST: "127.0.0.1", PORT: "1", HEALTHCHECK_RETRIES: "5" }, encoding: "utf8"
    });
    expect(result.status).toBe(ready ? 0 : 1);
    expect(result.stdout.trim()).toBe(ready ? listener : "");
  }
);

it("does not start an unbounded curl if the clock expires between the loop check and remaining budget", () => {
  const script = [
    'source "$1"',
    'curl() { printf "%s\\n" "$*" >&3; return 1; }',
    'SECONDS=0',
    'set -T',
    // Advance the clock immediately after the loop admitted this attempt.
    'trap \'case "$BASH_COMMAND" in remaining=*) SECONDS=1;; esac\' DEBUG',
    'wait_for_server 3>&1'
  ].join("\n");
  const result = spawnSync("/bin/bash", ["-c", script, "synthetic", path.resolve("scripts/service-common.sh")], {
    env: { ...process.env, HEALTHCHECK_HOST: "127.0.0.1", PORT: "1", HEALTHCHECK_RETRIES: "1" },
    encoding: "utf8", timeout: 1500
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
});

it.each([false, true])("bounds a real health request and returns truthful readiness (responds=%s)", async (responds) => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; if (responds) res.end("{}"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected synthetic TCP listener");
  const started = performance.now();
  try {
    const child = spawn("/bin/bash", ["-c", 'source "$1"; wait_for_server', "synthetic", path.resolve("scripts/service-common.sh")], {
      // Bash SECONDS can cross a wall-second boundary just after startup.
      env: { ...process.env, HEALTHCHECK_HOST: "127.0.0.1", PORT: String(address.port), HEALTHCHECK_RETRIES: responds ? "5" : "1" },
      timeout: 3000, stdio: "ignore"
    });
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    expect(result.signal).toBeNull();
    expect(result.code).toBe(responds ? 0 : 1);
    expect(performance.now() - started).toBeLessThan(1800);
    expect(requests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
