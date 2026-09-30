import { afterEach } from "vitest";
import { cleanup, cleanupEnvKeys } from "./server-test-utils.js";

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  for (const key of cleanupEnvKeys) {
    delete process.env[key];
  }
  cleanupEnvKeys.clear();
});
