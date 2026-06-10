import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT_DIR, "src");

describe("architecture boundaries", () => {
  it("keeps shared, server, and ui dependencies one-way", async () => {
    const imports = await readSourceImports();
    const violations = imports.flatMap((entry) => {
      const fromLayer = layerFor(entry.file);
      return entry.imports
        .map((specifier) => ({
          specifier,
          resolved: resolveLocalImport(entry.file, specifier)
        }))
        .filter((item): item is { specifier: string; resolved: string } => item.resolved !== null)
        .map(({ specifier, resolved }) => ({
          file: entry.file,
          specifier,
          toLayer: layerFor(resolved),
          fromLayer
        }))
        .filter(({ fromLayer, toLayer }) => {
          if (fromLayer === "shared") {
            return toLayer !== "shared";
          }
          if (fromLayer === "server") {
            return toLayer === "ui";
          }
          if (fromLayer === "ui") {
            return toLayer === "server";
          }
          return false;
        });
    });

    expect(formatViolations(violations)).toEqual([]);
  });

  it("keeps persistence and proxy transaction helpers below orchestration modules", async () => {
    const imports = await readSourceImports();
    const byFile = new Map(imports.map((entry) => [relativePath(entry.file), entry.imports]));

    expect(forbiddenImports(byFile, {
      "src/server/config.ts": ["node:fs", "node:fs/promises"],
      "src/server/config-profile-mutations.ts": ["node:fs", "node:fs/promises"],
      "src/server/config-profile-scope.ts": ["node:fs", "node:fs/promises"],
      "src/server/config-profile-scope-merge.ts": ["node:fs", "node:fs/promises"],
      "src/server/compaction-bridge.ts": ["node:zlib"],
      "src/server/openai-proxy-transaction.ts": [
        "./openai-proxy.js",
        "./claude-proxy.js",
        "./upstream-client.js"
      ],
      "src/server/proxy-support.ts": [
        "./openai-proxy.js",
        "./claude-proxy.js",
        "./upstream-client.js"
      ]
    })).toEqual([]);
  });
});

type Layer = "shared" | "server" | "ui" | "other";

interface SourceImport {
  file: string;
  imports: string[];
}

async function readSourceImports(): Promise<SourceImport[]> {
  const files = await readSourceFiles(SRC_DIR);
  return Promise.all(files.map(async (file) => ({
    file,
    imports: extractImportSpecifiers(await fs.readFile(file, "utf8"))
  })));
}

async function readSourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return readSourceFiles(fullPath);
    }
    return /\.(tsx?|jsx?)$/.test(entry.name) ? [fullPath] : [];
  }));
  return nested.flat().sort();
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importExportPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(importExportPattern)) {
    specifiers.push(match[1]);
  }
  for (const match of source.matchAll(dynamicImportPattern)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveLocalImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const resolved = path.resolve(path.dirname(fromFile), specifier);
  return resolved.endsWith(".js")
    ? resolved.slice(0, -".js".length) + ".ts"
    : resolved;
}

function layerFor(file: string): Layer {
  const relative = relativePath(file);
  if (relative.startsWith("src/shared/")) {
    return "shared";
  }
  if (relative.startsWith("src/server/")) {
    return "server";
  }
  if (relative.startsWith("src/ui/")) {
    return "ui";
  }
  return "other";
}

function forbiddenImports(
  importsByFile: Map<string, string[]>,
  rules: Record<string, string[]>
): string[] {
  return Object.entries(rules).flatMap(([file, forbidden]) => {
    const imports = importsByFile.get(file) ?? [];
    return forbidden
      .filter((specifier) => imports.includes(specifier))
      .map((specifier) => `${file} must not import ${specifier}`);
  });
}

function formatViolations(
  violations: Array<{ file: string; specifier: string; fromLayer: Layer; toLayer: Layer }>
): string[] {
  return violations.map((violation) =>
    `${relativePath(violation.file)} imports ${violation.specifier} from ${violation.fromLayer} to ${violation.toLayer}`
  );
}

function relativePath(file: string): string {
  return path.relative(ROOT_DIR, file).split(path.sep).join("/");
}
