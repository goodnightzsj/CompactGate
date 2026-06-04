import { spawnSync } from "node:child_process";
import { ConfigStore, parseListenAddress } from "./config.js";
import { createCompactGateServer, createRequestLogger } from "./http.js";

const configPath = process.env.COMPACTGATE_CONFIG ?? "compactgate.json";
const configStore = await ConfigStore.load(configPath);
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

function describeListener(port: number): string | null {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8"
  });

  if (result.error) {
    return null;
  }

  const output = result.stdout.trim();
  return output.length > 0 ? output : null;
}
