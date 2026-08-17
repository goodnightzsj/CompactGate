import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
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
    const known = new Set(imports.map((entry) => relativePath(entry.file)));

    // A rule whose files were renamed or deleted would silently pass forever, so
    // treat a rule that no longer matches reality as a failure in its own right.
    expect(staleRules(known)).toEqual([]);

    const violations = imports.flatMap((entry) => {
      const file = relativePath(entry.file);
      return BOUNDARY_RULES
        .filter((rule) => rule.pattern.test(file) && !rule.exempt?.includes(file))
        .flatMap((rule) =>
          rule.forbidden
            .filter((specifier) => entry.imports.includes(specifier))
            .map((specifier) => `${file} must not import ${specifier} (${rule.reason})`)
        );
    });

    expect(violations).toEqual([]);
  });
});

interface BoundaryRule {
  reason: string;
  // Matched against every current and future source file, so new files in these
  // layers are covered without touching this table.
  pattern: RegExp;
  exempt?: string[];
  forbidden: string[];
}

const BOUNDARY_RULES: BoundaryRule[] = [
  {
    reason: "config persistence belongs in config-file-repository.ts",
    pattern: /^src\/server\/config/,
    exempt: ["src/server/config-file-repository.ts"],
    forbidden: ["node:fs", "node:fs/promises"]
  },
  {
    reason: "transport compression belongs in the upstream stream helpers",
    pattern: /^src\/server\/compaction-bridge\.ts$/,
    forbidden: ["node:zlib"]
  },
  {
    reason: "this module sits below the orchestration layer",
    pattern: /^src\/server\/(?:openai-proxy-transaction|proxy-support)\.ts$/,
    forbidden: ["./openai-proxy.js", "./claude-proxy.js", "./upstream-client.js"]
  }
];

function staleRules(known: Set<string>): string[] {
  return BOUNDARY_RULES.flatMap((rule) => {
    const matched = [...known].filter((file) => rule.pattern.test(file));
    const problems = matched.length === 0 ? ["matches no source file"] : [];

    for (const file of rule.exempt ?? []) {
      if (!known.has(file)) {
        problems.push(`exempts ${file}, which no longer exists`);
      }
    }

    for (const specifier of rule.forbidden) {
      const resolved = matched.length === 0
        ? null
        : resolveLocalImport(path.join(ROOT_DIR, matched[0]), specifier);
      if (resolved !== null && !known.has(relativePath(resolved))) {
        problems.push(`forbids ${specifier}, which no longer exists`);
      }
    }

    return problems.map((problem) => `rule ${rule.pattern} ${problem}; update or remove it`);
  });
}

type Layer = "shared" | "server" | "ui" | "other";

interface SourceImport {
  file: string;
  imports: string[];
}

async function readSourceImports(): Promise<SourceImport[]> {
  const files = await readSourceFiles(SRC_DIR);
  return Promise.all(files.map(async (file) => ({
    file,
    imports: extractImportSpecifiers(await readFile(file, "utf8"))
  })));
}

async function readSourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const file of glob("**/*.{ts,tsx,js,jsx}", { cwd: directory })) {
    files.push(path.join(directory, file));
  }
  return files.sort();
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
