import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, DEFAULT_CONFIG } from "../src/server/config.js";
import {
  listConfigBackups,
  readConfigBackup,
  writeConfigFile
} from "../src/server/config-file-repository.js";
import type { CompactGateConfig } from "../src/shared/types.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

function withKeepRecent(value: number): CompactGateConfig {
  return {
    ...DEFAULT_CONFIG,
    logging: {
      ...DEFAULT_CONFIG.logging,
      keep_recent: value
    }
  };
}

describe("config file repository", () => {
  it("writes private files and keeps the ten newest prior versions", async () => {
    const dir = await makeConfigDir();
    const configPath = path.join(dir, "compactgate.json");

    await writeConfigFile(configPath, withKeepRecent(0));
    await chmod(configPath, 0o644);
    for (let index = 1; index <= 12; index += 1) {
      await writeConfigFile(configPath, withKeepRecent(index));
    }

    const backups = await listConfigBackups(configPath);
    expect(backups).toHaveLength(10);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    for (const backup of backups) {
      expect((await stat(path.join(dir, backup.id))).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      logging: { keep_recent: 12 }
    });
    expect(await readConfigBackup(configPath, backups[0]!.id)).toMatchObject({
      logging: { keep_recent: 11 }
    });
  });

  it("restores a validated backup without changing state on invalid JSON", async () => {
    const dir = await makeConfigDir();
    const configPath = path.join(dir, "compactgate.json");
    const store = await ConfigStore.load(configPath);

    await store.patch({ logging: { keep_recent: 1 } });
    await store.patch({ logging: { keep_recent: 2 } });
    const [firstBackup] = await store.listBackups();
    expect(firstBackup).toBeDefined();

    await store.patch({ logging: { keep_recent: 3 } });
    await store.restoreBackup(firstBackup!.id);
    expect(store.get().logging.keep_recent).toBe(1);

    const [latestBackup] = await store.listBackups();
    expect(await readConfigBackup(configPath, latestBackup!.id)).toMatchObject({
      logging: { keep_recent: 3 }
    });

    await writeFile(path.join(dir, latestBackup!.id), "{invalid", { mode: 0o600 });
    await expect(store.restoreBackup(latestBackup!.id)).rejects.toThrow(
      "Config backup must contain valid JSON."
    );
    expect(store.get().logging.keep_recent).toBe(1);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      logging: { keep_recent: 1 }
    });
  });

  it("rejects arbitrary backup paths", async () => {
    const dir = await makeConfigDir();
    const store = await ConfigStore.load(path.join(dir, "compactgate.json"));

    await expect(store.restoreBackup("../compactgate.json")).rejects.toThrow(
      "Invalid config backup id."
    );
    await expect(store.deleteBackup("compactgate.json")).rejects.toThrow(
      "Invalid config backup id."
    );
  });
});
