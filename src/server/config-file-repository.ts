import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CompactGateConfig } from "../shared/types.js";
import { ConfigError } from "./config-error.js";

const CONFIG_FILE_MODE = 0o600;
const MAX_CONFIG_BACKUPS = 10;

export interface ConfigBackupMetadata {
  id: string;
  created_at: string;
  size_bytes: number;
}

export interface LoadedConfigFile {
  resolvedPath: string;
  value: unknown;
  missing: boolean;
}

export async function readConfigFile(configPath: string): Promise<LoadedConfigFile> {
  const resolvedPath = path.resolve(configPath);
  try {
    const raw = await fs.readFile(resolvedPath, "utf8");
    return {
      resolvedPath,
      value: JSON.parse(raw) as unknown,
      missing: false
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }

    return {
      resolvedPath,
      value: null,
      missing: true
    };
  }
}

export async function writeConfigFile(
  configPath: string,
  config: CompactGateConfig
): Promise<string> {
  const resolvedPath = path.resolve(configPath);
  const directory = path.dirname(resolvedPath);
  await fs.mkdir(directory, { recursive: true });
  await backupCurrentConfig(resolvedPath);
  await pruneConfigBackups(resolvedPath, MAX_CONFIG_BACKUPS);
  await writeFileAtomically(resolvedPath, `${JSON.stringify(config, null, 2)}\n`);
  return new Date().toISOString();
}

export async function listConfigBackups(configPath: string): Promise<ConfigBackupMetadata[]> {
  const resolvedPath = path.resolve(configPath);
  const directory = path.dirname(resolvedPath);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const backups = await Promise.all(entries
    .filter((entry) => entry.isFile() && isConfigBackupId(resolvedPath, entry.name))
    .map(async (entry) => {
      const stats = await fs.stat(path.join(directory, entry.name));
      return {
        id: entry.name,
        created_at: stats.mtime.toISOString(),
        size_bytes: stats.size,
        mtimeMs: stats.mtimeMs
      };
    }));

  return backups
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.id.localeCompare(left.id))
    .map(({ mtimeMs: _mtimeMs, ...metadata }) => metadata);
}

export async function readConfigBackup(configPath: string, backupId: string): Promise<unknown> {
  const backupPath = resolveConfigBackupPath(configPath, backupId);
  try {
    return JSON.parse(await fs.readFile(backupPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError("Config backup was not found.");
    }
    throw error;
  }
}

export async function deleteConfigBackup(configPath: string, backupId: string): Promise<void> {
  const resolvedPath = path.resolve(configPath);
  try {
    await fs.rm(resolveConfigBackupPath(resolvedPath, backupId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError("Config backup was not found.");
    }
    throw error;
  }
  await syncDirectory(path.dirname(resolvedPath));
}

async function backupCurrentConfig(configPath: string): Promise<void> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const timestamp = Date.now().toString().padStart(13, "0");
  const backupId = `${path.basename(configPath)}.backup.${timestamp}.${randomUUID()}.json`;
  await writeFileAtomically(path.join(path.dirname(configPath), backupId), raw);
}

async function pruneConfigBackups(configPath: string, keep: number): Promise<void> {
  const backups = await listConfigBackups(configPath);
  for (const backup of backups.slice(keep)) {
    await deleteConfigBackup(configPath, backup.id);
  }
}

async function writeFileAtomically(filePath: string, contents: string | Buffer): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, "wx", CONFIG_FILE_MODE);
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, CONFIG_FILE_MODE);
    await syncDirectory(directory);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function resolveConfigBackupPath(configPath: string, backupId: string): string {
  const resolvedPath = path.resolve(configPath);
  if (!isConfigBackupId(resolvedPath, backupId)) {
    throw new ConfigError("Invalid config backup id.");
  }
  return path.join(path.dirname(resolvedPath), backupId);
}

function isConfigBackupId(configPath: string, backupId: string): boolean {
  if (path.basename(backupId) !== backupId) {
    return false;
  }
  const prefix = `${path.basename(configPath)}.backup.`;
  return backupId.startsWith(prefix) &&
    /^\d{13}\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i
      .test(backupId.slice(prefix.length));
}
