import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

it.each(["tsconfig.json", "tsconfig.server.json", "build", "missing", ""])(
  "shows build output and schedules a restart only on success (failure: %s)",
  async (failedStep) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "compactgate-restart-test-"));
    const bin = path.join(dir, "node_modules/.bin");
    const runtime = path.join(dir, "runtime");
    const log = path.join(runtime, "compactgate.restart.log");
    const scheduled = path.join(dir, "scheduled");
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
      // Intercept the detached launcher; never run a real restart worker.
      writeFileSync(path.join(bin, "setsid"), '#!/bin/bash\n: > "$PROJECT_DIR/scheduled"\n', { mode: 0o755 });
      const result = spawnSync("/bin/bash", [path.resolve("scripts/restart-service.sh")], {
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
        expect(existsSync(scheduled)).toBe(false);
        const steps = ["tsconfig.json", "tsconfig.server.json", "build"];
        for (const laterStep of steps.slice(steps.indexOf(failedStep) + 1)) {
          expect(savedLog).not.toContain(`running ${laterStep}`);
        }
      } else {
        expect(result.status).toBe(0);
        expect(output).toContain("Build complete; scheduling restart worker");
        expect(output).toContain("Scheduled CompactGate restart for http://127.0.0.1:7865");
        await vi.waitFor(() => expect(existsSync(scheduled)).toBe(true));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
