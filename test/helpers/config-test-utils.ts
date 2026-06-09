import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

const cleanupPaths: string[] = [];

export async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-config-"));
  cleanupPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
  delete process.env.PRIMARY_API_KEY;
});
