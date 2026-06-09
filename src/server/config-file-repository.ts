import { promises as fs } from "node:fs";
import path from "node:path";
import type { CompactGateConfig } from "../shared/types.js";

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
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8"
  );
  return new Date().toISOString();
}
