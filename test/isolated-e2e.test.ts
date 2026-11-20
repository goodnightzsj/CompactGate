import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.each([false, true])("isolates source data and cleans generated files, failed shutdown=%s", async failedShutdown => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-isolation-test-"));
  const captures = path.join(dir, "source-captures");
  const sourcePath = path.join(dir, "source.json");
  let sourceReads = 0;
  const source = http.createServer((_req, res) => {
    sourceReads++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ config_path: sourcePath }));
  });
  await new Promise<void>(resolve => source.listen(0, "127.0.0.1", resolve));
  const address = source.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  try {
    await mkdir(captures);
    await writeFile(path.join(captures, "sentinel.json"), "synthetic source capture");
    const config = JSON.stringify({ primary: { api_key: "synthetic-source-secret" }, logging: { capture_dir: captures } });
    await writeFile(sourcePath, config);
    const preload = path.join(dir, "fail-shutdown.mjs");
    if (failedShutdown) await writeFile(preload, `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  if (args[1]?.[0]?.endsWith("/dist/server/main.js")) {
    const kill = child.kill.bind(child);
    child.kill = signal => kill(signal === "SIGTERM" ? "SIGKILL" : signal);
  }
  return child;
};
syncBuiltinESMExports();
`);
    let shutdownFailed = false;
    const result = await promisify(execFile)(process.execPath, [...(failedShutdown ? ["--import", preload] : []), "scripts/isolated-e2e.mjs"], {
      cwd: process.cwd(), timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, TMPDIR: dir, CI: "1",
        COMPACTGATE_SOURCE_URL: `http://127.0.0.1:${address.port}`, COMPACTGATE_SOURCE_CONFIG: sourcePath,
        COMPACTGATE_CONFIG: sourcePath, COMPACTGATE_CAPTURE_DIR: captures, COMPACTGATE_LOG_DB: path.join(dir, "source.sqlite"),
        ANTHROPIC_AUTH_TOKEN: "synthetic-inherited-credential" }
    }).catch(error => {
      if (!failedShutdown) throw error;
      shutdownFailed = true;
      expect(error.stderr).toContain("Isolated server shutdown failed (SIGKILL)");
      return { stdout: String(error.stdout), stderr: String(error.stderr) };
    });
    expect(shutdownFailed).toBe(failedShutdown);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ ok: true, data_source: "synthetic",
      checks: expect.arrayContaining(["health", "config", "frontend-entrypoints", "logs-api", "studio-events"]) });
    expect(output.config_path.startsWith(path.join(dir, "compactgate-isolated-e2e-"))).toBe(true);
    expect(sourceReads).toBe(0);
    expect(await readFile(sourcePath, "utf8")).toBe(config);
    expect(await readdir(captures)).toEqual(["sentinel.json"]);
    expect(await readdir(dir)).toEqual(expect.arrayContaining(["source.json", "source-captures"]));
    expect((await readdir(dir)).filter(name => name.endsWith(".sqlite") || name.startsWith("compactgate-isolated-e2e-"))).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain("synthetic-source-secret");
    await expect(fetch(`${output.url}/api/health`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  } finally {
    source.closeAllConnections();
    await new Promise<void>((resolve, reject) => source.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 130_000);
