import { readFile, utimes } from "node:fs/promises";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { FileCommitError, readConfigBackup } from "../src/server/config-file-repository.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";
import { injectFileCommitFault } from "./helpers/file-commit-fault.js";

const stores: ConfigStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.oauth.close()); vi.restoreAllMocks(); });

async function fixture() {
  const file = path.join(await makeConfigDir(), "synthetic.json");
  const store = await ConfigStore.load(file);
  stores.push(store);
  for (const value of [10, 20, 30, 40]) await store.patch({ logging: { keep_recent: value } });
  for (const backup of await store.listBackups()) {
    const value = (await readConfigBackup(file, backup.id) as { logging: { keep_recent: number } }).logging.keep_recent;
    const timestamp = new Date(1_700_000_000_000 + value);
    await utimes(path.join(path.dirname(file), backup.id), timestamp, timestamp);
  }
  const backups = await store.listBackups();
  expect(backups).toHaveLength(3);
  const oldest = backups.at(-1)!;
  expect(await readConfigBackup(file, oldest.id)).toMatchObject({ logging: { keep_recent: 10 } });
  return { store, file, backups, oldest };
}

it("normal restoration replaces the main file and rotates to three backups", async () => {
  const { store, file, oldest } = await fixture();
  await expect(store.restoreBackup(oldest.id)).resolves.toMatchObject({ logging: { keep_recent: 10 } });
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ logging: { keep_recent: 10 } });
  expect(await store.listBackups()).toHaveLength(3);
});

it.each(["file-chmod", "file-sync"] as const)("a restore failing at %s retains its source backup so it can be retried", async stage => {
  const { store, file, oldest } = await fixture();
  const before = await readFile(file, "utf8");
  const revision = store.revision;
  const fault = injectFileCommitFault(file, stage);
  await expect(store.restoreBackup(oldest.id)).rejects.toBe(fault);
  expect(await readFile(file, "utf8")).toBe(before);
  expect(store.revision).toBe(revision);
  expect(store.get().logging.keep_recent).toBe(40);
  expect.soft((await store.listBackups()).map(backup => backup.id)).toContain(oldest.id);
  expect(await store.listBackups()).toHaveLength(3);
  await expect(store.restoreBackup(oldest.id)).resolves.toMatchObject({ logging: { keep_recent: 10 } });
});

it("three failed saves retain at least one earlier distinct configuration", async () => {
  const { store, file } = await fixture();
  const before = await readFile(file, "utf8");
  for (const value of [50, 60, 70]) {
    const fault = injectFileCommitFault(file, "file-sync");
    await expect(store.patch({ logging: { keep_recent: value } })).rejects.toBe(fault);
    vi.restoreAllMocks();
  }
  expect(await readFile(file, "utf8")).toBe(before);
  const versions = await Promise.all((await store.listBackups()).map(async backup =>
    (await readConfigBackup(file, backup.id) as { logging: { keep_recent: number } }).logging.keep_recent));
  expect(versions.sort((a, b) => a - b)).toEqual([10, 20, 30]);
});

it("keeps committed config and revision when pruning fails after replacement", async () => {
  const { store, file, oldest } = await fixture();
  const revision = store.revision;
  const fault = new Error("synthetic backup removal failure");
  const remove = fs.rm;
  vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
    if (target === path.join(path.dirname(file), oldest.id)) throw fault;
    return remove(target, options);
  });
  const result = store.patch({ logging: { keep_recent: 50 } });
  await expect(result).rejects.toBeInstanceOf(FileCommitError);
  await expect(result).rejects.toMatchObject({ filePath: file, cause: fault, message: expect.stringMatching(/committed.*backup cleanup failed/) });
  expect(store.get().logging.keep_recent).toBe(50);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(store.get());
  expect(store.revision).not.toBe(revision);
  await expect(store.patch({ revision, logging: { keep_recent: 60 } })).rejects.toMatchObject({ status: 409 });
  expect(await store.listBackups()).toHaveLength(4);
  vi.restoreAllMocks();
  await store.patch({ logging: { keep_recent: 60 } });
  expect(await store.listBackups()).toHaveLength(3);
});
