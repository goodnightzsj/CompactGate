import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.each([["42", "0", 0], ["41", "0", 1], ["42", "1", 1]] as const)(
  "checks an existing listener during deferred start (job %s, health %s)", (job, health, expectedStatus) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "compactgate-defer-test-"));
    try {
      const script = [
        'lsof() { echo 42; }',
        'curl() { return "$STUB_HEALTH"; }',
        'launchctl() { if [[ "$1" == print ]]; then echo "pid = $STUB_JOB"; else echo "unexpected mutation $1"; fi; }',
        'sleep() { if [[ "$1" != 0 ]]; then SECONDS=100; fi; }',
        'source "$1" --fire 0'
      ].join("\n");
      const result = spawnSync("/bin/bash", ["-c", script, "fixture", path.resolve("scripts/defer-start.sh")], {
        cwd: dir, env: { PATH: "/usr/bin:/bin", NODE_BIN: process.execPath, PROJECT_DIR: dir, RUNTIME_DIR: dir,
          HEALTHCHECK_RETRIES: "5", STUB_JOB: job, STUB_HEALTH: health }, timeout: 3000
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(expectedStatus);
      const log = readFileSync(path.join(dir, "compactgate.defer-start.log"), "utf8");
      expect(log).toContain(expectedStatus === 0 ? "is healthy and listening" : "could not be verified");
      expect(log).not.toContain("unexpected mutation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

it.each(["tsconfig.json", "tsconfig.server.json", "build", "missing", ""])(
  "shows build output and schedules a restart only on success (failure: %s)",
  (failedStep) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "compactgate-restart-test-"));
    const bin = path.join(dir, "node_modules/.bin");
    const runtime = path.join(dir, "runtime");
    const log = path.join(runtime, "compactgate.restart.log");
    const script = path.resolve("scripts/restart-service.sh");
    try {
      mkdirSync(bin, { recursive: true });
      mkdirSync(runtime);
      writeFileSync(log, "previous restart log\n");
      const buildTool = `#!/bin/bash
step="\${2:-$1}"
echo "running $step"
if [[ "$step" == "$STUB_FAIL" ]]; then
  echo "synthetic build failure: $step" >&2
  exit 23
fi
`;
      if (failedStep !== "missing") {
        for (const tool of ["tsc", "vite"]) {
          writeFileSync(path.join(bin, tool), buildTool, { mode: 0o755 });
        }
      }
      // The inherited pipe stays open until the detached stub reports its arguments and exits.
      writeFileSync(path.join(bin, "setsid"), '#!/bin/bash\nprintf "%s\\n" "$@" >&3\n', { mode: 0o755 });
      const result = spawnSync("/bin/bash", [script], {
        cwd: dir,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          NODE_BIN: process.execPath,
          PROJECT_DIR: dir,
          COMPACTGATE_CONFIG: path.join(dir, "missing-config.json"),
          RUNTIME_DIR: runtime,
          STUB_FAIL: failedStep
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        timeout: 5000
      });
      expect(result.error).toBeUndefined();
      const output = result.stdout + result.stderr;
      const savedLog = readFileSync(log, "utf8");
      expect(savedLog).toMatch(/^previous restart log\n/);
      if (failedStep) {
        const error = failedStep === "missing"
          ? "Missing local build tools. Run npm install first."
          : `synthetic build failure: ${failedStep}`;
        expect(result.status).toBe(failedStep === "missing" ? 1 : 23);
        expect(output).toContain(error);
        expect(savedLog).toContain(error);
        expect(output).not.toContain("Scheduled CompactGate restart");
        expect(savedLog).not.toContain("Build complete");
        expect(result.output[3]).toBe("");
        const steps = ["tsconfig.json", "tsconfig.server.json", "build"];
        for (const laterStep of steps.slice(steps.indexOf(failedStep) + 1)) {
          expect(savedLog).not.toContain(`running ${laterStep}`);
        }
      } else {
        expect(result.status).toBe(0);
        expect(output).toContain("Build complete; scheduling restart worker");
        expect(output).toContain("Scheduled CompactGate restart for http://127.0.0.1:7865");
        expect(result.output[3]).toBe(`bash\n${script}\n--worker\n`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
