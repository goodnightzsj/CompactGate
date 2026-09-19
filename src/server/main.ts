import { spawnSync } from "node:child_process";
import path from "node:path";
import { ConfigStore, parseListenAddress } from "./config.js";
import { listConfigBackups } from "./config-file-repository.js";
import { createCompactGateServer, createRequestLogger } from "./http.js";

// The launchd label names the job, not the process. Without this the kernel
// name stays "node" and the command line shows the nvm path and dist/server/main.js,
// so the service is unrecognisable in Activity Monitor, `ps` and `top`.
// setproctitle replaces both comm and argv, which also makes the process
// greppable by name — the tradeoff is that the argv path is no longer visible
// there; `launchctl print gui/$(id -u)/compactgate` still has it.
process.title = "compactgate";

const configPath = process.env.COMPACTGATE_CONFIG ?? "compactgate.json";

/** How long a shutdown waits for in-flight proxied requests before cutting them. */
const SHUTDOWN_GRACE_MS = 3_000;

const configStore = await loadConfigStore(configPath);
const { host, port } = parseListenAddress(configStore.get().listen);
const logger = createRequestLogger(configStore);
const server = await createCompactGateServer(configStore, logger);

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    const target = `${host}:${port}`;
    const details = describeListener(port);

    console.error(`CompactGate could not start because ${target} is already in use.`);
    if (details) {
      console.error("Current listener:");
      console.error(details);
    } else {
      console.error(`Inspect it with: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    }
    console.error("Use `npm restart` to replace the existing CompactGate service.");
    process.exit(1);
  }

  console.error("CompactGate failed to start.");
  console.error(error);
  process.exit(1);
});

server.listen(port, host, () => {
  const config = configStore.get();
  console.log(`CompactGate listening on http://${config.listen}`);
  console.log(`OpenAI-compatible base URL: http://${config.listen}/v1`);
  console.log(`Log database: ${logger.getDatabasePath()}`);
});

/**
 * launchd supervises this process with KeepAlive{SuccessfulExit:false}, so the
 * exit code is a signal, not a formality: exit 0 means "stopped on purpose, do
 * not relaunch", anything else means "crashed, bring it back".
 *
 * Without this, SIGTERM hit Node's default handler and the process died by
 * signal (reported as a failure) — so `npm stop` would be undone by an immediate
 * relaunch. It also means the `close` handler that checkpoints the WAL and
 * closes SQLite ran on shutdown paths that never happened, leaving the -wal file
 * for the next boot to recover.
 */
function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}; shutting down.`);

  // A second signal means the graceful path is stuck (a synchronous VACUUM on a
  // large database cannot be interrupted) — honour the operator instead of hanging.
  process.once(signal, () => {
    console.error(`Received ${signal} again during shutdown; exiting immediately.`);
    process.exit(1);
  });

  server.close((error) => {
    if (error) {
      console.error("CompactGate failed to shut down cleanly.", error);
      process.exit(1);
    }
    process.exit(0);
  });

  // Studio holds a long-lived SSE stream on /api/events that never ends on its
  // own, so `close` would wait forever and never reach the callback above — no
  // WAL checkpoint, and launchd would report a signal death instead of a clean
  // stop. Drop idle keep-alives at once, then force whatever is left after a
  // short grace period so an in-flight proxied request can still finish.
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

function describeListener(port: number): string | null {  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8"
  });

  if (result.error) {
    return null;
  }

  const output = result.stdout.trim();
  return output.length > 0 ? output : null;
}

/**
 * A malformed or invalid config file used to exit with a bare unhandled
 * rejection, and the ten good backups sitting beside it are only reachable
 * through the HTTP API of the service that just failed to start. Deliberately
 * no auto-restore — `restoreBackup` requires an explicit confirmation for the
 * same reason — but the operator does get told what broke and how to recover.
 */
async function loadConfigStore(target: string): Promise<ConfigStore> {
  try {
    return await ConfigStore.load(target);
  } catch (error) {
    const resolved = path.resolve(target);
    console.error(`CompactGate could not load its config from ${resolved}.`);
    console.error(error instanceof Error ? error.message : error);

    const backups = await listConfigBackups(target).catch(() => []);
    if (backups.length > 0) {
      console.error("");
      console.error("Version backups beside it, newest first:");
      for (const backup of backups.slice(0, 5)) {
        console.error(`  ${backup.id}  ${backup.created_at}  ${backup.size_bytes} bytes`);
      }
      console.error("");
      console.error("Restore one with:");
      console.error(`  cp ${path.join(path.dirname(resolved), backups[0].id)} ${resolved}`);
    }

    process.exit(1);
  }
}
