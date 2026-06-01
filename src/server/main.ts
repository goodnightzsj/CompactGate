import { ConfigStore, parseListenAddress } from "./config.js";
import { createCompactGateServer } from "./http.js";

const configPath = process.env.COMPACTGATE_CONFIG ?? "compactgate.json";
const configStore = await ConfigStore.load(configPath);
const { host, port } = parseListenAddress(configStore.get().listen);
const server = createCompactGateServer(configStore);

server.listen(port, host, () => {
  const config = configStore.get();
  console.log(`CompactGate listening on http://${config.listen}`);
  console.log(`OpenAI-compatible base URL: http://${config.listen}/v1`);
});
