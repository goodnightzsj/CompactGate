import { afterEach } from "vitest";
import { cleanup, cleanupEnvKeys } from "./server-test-utils.js";

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
  for (const key of cleanupEnvKeys) {
    delete process.env[key];
  }
  cleanupEnvKeys.clear();
});
