import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.each(["normal", "delay-then-signal", "delay-then-wait", "delay-then-fail", "compact-delay-then-signal", "compact-delay-then-fail"])("drains an automatic profile commit during real main.ts SIGTERM, mode=%s", async mode => {
  const delayed = mode !== "normal";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compactgate-scheduled-shutdown-"));
  const configPath = path.join(dir, "compactgate.json");
  const script = `
    import http from 'node:http';
    import { promises as fs } from 'node:fs';
    import path from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    import { ConfigStore } from './src/server/config.ts';
    import { DEFAULT_CONFIG } from './src/server/config-defaults.ts';
    import { CodexVersionMonitor } from './src/server/codex-version.ts';
    import { ClientIdentityStore } from './src/server/client-identity-store.ts';
    CodexVersionMonitor.prototype.start = function() {};
    ClientIdentityStore.prototype.start = async function() {};
    const fixturePath = process.argv[1];
    const delayed = process.argv[2] === 'true';
    const waitForCommit = process.argv[3] === 'delay-then-wait';
    const failCommit = process.argv[3].endsWith('delay-then-fail');
    const upstream = http.createServer(async (req, res) => {
      for await (const chunk of req) void chunk;
      const failed = req.headers.authorization === 'Bearer synthetic-a';
      res.writeHead(failed ? 401 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(failed ? { error: 'Invalid API key' } : { id: 'resp_ok', status: 'completed', output: [] }));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = 'http://127.0.0.1:' + upstream.address().port;
    const listenProbe = http.createServer();
    await new Promise(resolve => listenProbe.listen(0, '127.0.0.1', resolve));
    const port = listenProbe.address().port;
    await new Promise(resolve => listenProbe.close(resolve));
    const config = await ConfigStore.load(fixturePath);
    const primary = { ...DEFAULT_CONFIG.primary, base_url: upstreamUrl, api_key_env: '', api_key: 'synthetic-a' };
    const compact = { ...DEFAULT_CONFIG.compact, upstream_mode: 'primary' };
    await config.patch({ listen: '127.0.0.1:' + port, primary, compact,
      timeouts: { primary_ms: delayed ? 100 : 2000, compact_ms: delayed ? 100 : 2000 }, primary_failover: { auto_schedule: true },
      profile_scopes: { codex: { active_profile_id: 'a', profiles: [
        { id: 'a', name: 'A', config: { primary, compact } },
        { id: 'b', name: 'B', config: { primary: { ...primary, api_key: 'synthetic-b' }, compact } }
      ] } } });
    process.env.COMPACTGATE_CONFIG = fixturePath;
    const nativeListen = http.Server.prototype.listen;
    let listeningResolve;
    const listening = new Promise(resolve => { listeningResolve = resolve; });
    http.Server.prototype.listen = function(...args) {
      this.once('listening', () => listeningResolve());
      return nativeListen.apply(this, args);
    };
    await import('./src/server/main.ts');
    await listening;
    let requests = 0;
    const request = async () => {
      const endpoint = ++requests > 1 && process.argv[3].startsWith('compact-') ? '/v1/responses/compact' : '/v1/responses';
      const response = await fetch('http://127.0.0.1:' + port + endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'synthetic', input: 'synthetic' })
      });
      await response.text();
      await delay(30);
      return response.status;
    };
    console.log('FIRST_STATUS=' + await request());
    const open = fs.open;
    fs.open = async function(...args) {
      const [target, flags] = args;
      if (typeof target === 'string' && path.dirname(target) === path.dirname(fixturePath) &&
          /^\\.compactgate\\.json\\.\\d+\\./.test(path.basename(target)) && flags === 'wx') {
        console.log('COMMIT_ENTERED');
        if (delayed) await delay(2500);
        console.log('COMMIT_RELEASED');
        if (failCommit) throw new Error('Synthetic scheduled commit failure');
      }
      return open.apply(this, args);
    };
    console.log('SECOND_STATUS=' + await request());
    if (waitForCommit) await delay(2600);
    process.kill(process.pid, 'SIGTERM');
  `;
  const execution = promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, configPath, String(delayed), mode], {
    cwd: process.cwd(), env: { PATH: process.env.PATH! }, timeout: 8_000, maxBuffer: 1024 * 1024
  });
  if (mode.endsWith("delay-then-fail")) {
    await expect(execution).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Synthetic scheduled commit failure") });
    await fs.rm(dir, { recursive: true, force: true });
    return;
  }
  const result = await execution;
  const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
  expect(result.stdout).toContain("FIRST_STATUS=401");
  expect(result.stdout).toContain("COMMIT_ENTERED");
  expect(result.stdout).toContain(delayed ? "SECOND_STATUS=502" : "SECOND_STATUS=200");
  expect(saved.profile_scopes.codex.active_profile_id).toBe("b");
  expect(result.stderr).not.toContain("database is not open");
  await fs.rm(dir, { recursive: true, force: true });
});
