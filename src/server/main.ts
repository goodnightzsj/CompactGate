import { spawnSync } from "node:child_process";
import path from "node:path";
import { ConfigStore, parseListenAddress } from "./config.js";
import { listConfigBackups } from "./config-file-repository.js";
import { createCompactGateServer, createRequestLogger } from "./http.js";

const configPath = process.env.COMPACTGATE_CONFIG ?? "compactgate.json";
const configStore = await loadConfigStore(configPath);
const { host, port } = parseListenAddress(configStore.get().listen);
const logger = createRequestLogger(configStore);
const server = createCompactGateServer(configStore, logger);

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
