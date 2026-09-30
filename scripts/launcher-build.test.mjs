import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(tmpdir(), "compactgate-launcher-"));
mkdirSync(path.join(dir, "scripts"));
copyFileSync(path.join(root, "package.json"), path.join(dir, "package.json"));
copyFileSync(path.join(root, "scripts/launcher.c"), path.join(dir, "scripts/launcher.c"));
function build() {
  const result = spawnSync("npm", ["--prefix", dir, "run", "build:launcher"], {
    cwd: tmpdir(), encoding: "utf8", timeout: 30_000
  });
  assert.ifError(result.error);
  return result;
}
const built = build();
assert.equal(built.status, 0, built.stderr);
const shim = spawnSync(path.join(dir, "bin/compactgate"), ["/usr/bin/true"]);
assert.equal(shim.status, 0);
writeFileSync(path.join(dir, "scripts/launcher.c"), "invalid C source\n");
assert.notEqual(build().status, 0);
console.log("PASS: clean output directory, npm --prefix, executable shim, compiler failure");
