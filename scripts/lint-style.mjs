import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SOURCE_DIRS = ["src", "test", "scripts"];
const ROOT_FILES = [
  "package.json",
  "tsconfig.json",
  "tsconfig.server.json",
  "vite.config.ts"
];
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".json",
  ".mjs",
  ".ts",
  ".tsx"
]);
const APP_STYLE_MANIFEST = [
  { file: "tokens.css", role: "tokens" },
  { file: "foundation.css", role: "foundation", ownsSelectors: false },
  { file: "layout.css", role: "layout" },
  { file: "primitives.css", role: "primitives" },
  { file: "dashboard.css", role: "dashboard" },
  { file: "routes.css", role: "routes" },
  { file: "config.css", role: "config" },
  { file: "logs.css", role: "logs" },
  { file: "feedback.css", role: "feedback" },
  { file: "theme-overrides.css", role: "theme-overrides", ownsSelectors: false },
  { file: "motion.css", role: "motion", ownsSelectors: false },
  { file: "health.css", role: "health" },
  { file: "responsive.css", role: "responsive", ownsSelectors: false }
];
const ACTIVE_APP_STYLE_FILES = APP_STYLE_MANIFEST.map((entry) => entry.file);
const APP_STYLE_ROLES = new Map(
  APP_STYLE_MANIFEST.map((entry) => [entry.file, entry.role])
);
const SELECTOR_OWNERSHIP_FILES = new Set(
  APP_STYLE_MANIFEST
    .filter((entry) => entry.ownsSelectors !== false)
    .map((entry) => entry.file)
);
const RETIRED_APP_STYLE_FILES = new Set([
  "base.css",
  "console.css",
  "theme-system.css"
]);

const failures = [];

for (const file of await collectProjectFiles()) {
  await checkTextFile(file);
}

await checkCssStyleFiles();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Style drift check passed.");

async function collectProjectFiles() {
  const files = [];
  for (const directory of SOURCE_DIRS) {
    files.push(...await collectFiles(path.join(ROOT, directory)));
  }
  for (const file of ROOT_FILES) {
    files.push(path.join(ROOT, file));
  }
  return files
    .filter((file) => TEXT_EXTENSIONS.has(path.extname(file)))
    .sort();
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      files.push(...await collectFiles(fullPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function checkTextFile(file) {
  const text = await readFile(file, "utf8");
  const relative = relativePath(file);
  if (text.includes("\r\n")) {
    failures.push(`${relative}: uses CRLF line endings`);
  }
  if (text.length > 0 && !text.endsWith("\n")) {
    failures.push(`${relative}: missing final newline`);
  }
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (/[ \t]+$/.test(lines[index])) {
      failures.push(`${relative}:${index + 1}: trailing whitespace`);
    }
  }
}

async function checkCssStyleFiles() {
  const stylesDir = path.join(ROOT, "src/ui/styles/app");
  await checkAppStyleImports();
  const files = (await readdir(stylesDir))
    .filter((file) => file.endsWith(".css"))
    .sort();
  checkAppStyleFileSet(files);

  for (const file of files) {
    if (/^\d+-/.test(file)) {
      failures.push(`src/ui/styles/app/${file}: CSS style files must not use numeric prefixes`);
    }
  }

  const definitions = new Set();
  const variableUses = [];
  const selectorOwners = new Map();
  for (const file of files) {
    const fullPath = path.join(stylesDir, file);
    const relative = `src/ui/styles/app/${file}`;
    const text = await readFile(fullPath, "utf8");
    const css = stripCssComments(text);
    checkThemeOwnership(relative, file, css);
    checkLayerOwnership(relative, file, css);
    checkRedundantThemeSelectors(relative, css);
    checkUnsafeImportant(relative, css);
    collectOwnedSelectors(selectorOwners, relative, file, css);
    for (const match of css.matchAll(/--([a-zA-Z0-9_-]+)\s*:/g)) {
      definitions.add(`--${match[1]}`);
    }
    for (const match of css.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,([^)]*))?\)/g)) {
      variableUses.push({
        file: relative,
        name: match[1],
        hasFallback: match[2] !== undefined
      });
    }
  }

  for (const variable of variableUses) {
    if (!definitions.has(variable.name) && !variable.hasFallback) {
      failures.push(`${variable.file}: ${variable.name} is used without definition or fallback`);
    }
  }
  checkDuplicateSelectorOwnership(selectorOwners);
}

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, "")
  );
}

async function checkAppStyleImports() {
  const appCss = await readFile(path.join(ROOT, "src/ui/styles/app.css"), "utf8");
  const imports = [...appCss.matchAll(/@import\s+"\.\/app\/([^"]+)";/g)]
    .map((match) => match[1]);
  const expected = ACTIVE_APP_STYLE_FILES;
  if (imports.join("|") !== expected.join("|")) {
    failures.push(`src/ui/styles/app.css: must import exactly ${expected.join(", ")} in order`);
  }
  for (const retiredFile of RETIRED_APP_STYLE_FILES) {
    if (appCss.includes(retiredFile)) {
      failures.push(`src/ui/styles/app.css: must not import retired style layer ${retiredFile}`);
    }
  }
}

function checkAppStyleFileSet(files) {
  for (const retiredFile of RETIRED_APP_STYLE_FILES) {
    if (files.includes(retiredFile)) {
      failures.push(`src/ui/styles/app/${retiredFile}: retired style layer must be removed`);
    }
  }

  const activeSet = new Set(ACTIVE_APP_STYLE_FILES);
  for (const file of files) {
    if (!activeSet.has(file)) {
      failures.push(`src/ui/styles/app/${file}: app style files must be imported from src/ui/styles/app.css or removed`);
    }
  }
}

function checkThemeOwnership(file, basename, text) {
  const role = APP_STYLE_ROLES.get(basename);
  if (role !== "tokens" && /^:root\s*\{/m.test(text)) {
    failures.push(`${file}: global theme tokens must be defined in tokens.css`);
  }
  if (role !== "tokens" && text.includes(':root[data-theme="dark"]')) {
    failures.push(`${file}: component styles must use semantic tokens instead of dark-only selectors`);
  }
  if (role === "tokens") {
    checkThemeSystemDarkBlocks(file, text);
  }
}

function checkLayerOwnership(file, basename, text) {
  const role = APP_STYLE_ROLES.get(basename);
  if (text.includes("@media (prefers-reduced-motion: reduce)") && role !== "motion") {
    failures.push(`${file}: reduced-motion rules must live in motion.css`);
  }
  if (role === "responsive") {
    checkResponsiveOnlyContainsQueries(file, text);
    return;
  }
  if (role === "motion") {
    checkMotionOnlyContainsReducedMotion(file, text);
    return;
  }
  if (role === "health") {
    checkHealthSelectors(file, text);
    return;
  }
  if (/(^|[\s,{])\.(?:shell-health|health-[a-zA-Z0-9_-]+)/.test(text)) {
    failures.push(`${file}: health page selectors must live in health.css`);
  }
}

function checkHealthSelectors(file, text) {
  for (const rule of extractSelectorRules(text)) {
    for (const selector of rule.selectors) {
      if (!/(^|[\s>+~,(])\.(?:shell-health|health-[a-zA-Z0-9_-]+)/.test(selector)) {
        failures.push(`${file}:${rule.line}: health.css selector must be scoped to .shell-health or .health-* (${selector})`);
      }
    }
  }
}

function checkResponsiveOnlyContainsQueries(file, text) {
  const lines = text.split("\n");
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const depthBeforeLine = depth;
    if (
      trimmed.length > 0 &&
      depthBeforeLine === 0 &&
      !trimmed.startsWith("@media")
    ) {
      failures.push(`${file}:${index + 1}: responsive.css may only contain top-level @media rules`);
    }
    depth += countMatches(line, "{") - countMatches(line, "}");
    if (depth < 0) {
      depth = 0;
    }
  }
}

function checkMotionOnlyContainsReducedMotion(file, text) {
  const lines = text.split("\n");
  let depth = 0;
  let hasReducedMotionRule = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const depthBeforeLine = depth;
    if (
      trimmed.length > 0 &&
      depthBeforeLine === 0 &&
      !trimmed.startsWith("@media (prefers-reduced-motion: reduce)")
    ) {
      failures.push(`${file}:${index + 1}: motion.css may only contain the reduced-motion media rule`);
    }
    if (depthBeforeLine === 0 && trimmed.startsWith("@media (prefers-reduced-motion: reduce)")) {
      hasReducedMotionRule = true;
    }
    depth += countMatches(line, "{") - countMatches(line, "}");
    if (depth < 0) {
      depth = 0;
    }
  }
  if (!hasReducedMotionRule) {
    failures.push(`${file}: motion.css must define the reduced-motion media rule`);
  }
}

function checkThemeSystemDarkBlocks(file, text) {
  for (const match of text.matchAll(/:root\[data-theme="dark"\][^{]*\{([^}]*)\}/g)) {
    const declarations = match[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("/*") && !line.startsWith("*"));
    const hasComponentRule = declarations.some((line) => !line.startsWith("--"));
    if (hasComponentRule) {
      const line = text.slice(0, match.index).split("\n").length;
      failures.push(`${file}:${line}: dark theme blocks may only assign tokens`);
    }
  }
}

function collectOwnedSelectors(selectorOwners, file, basename, text) {
  if (!SELECTOR_OWNERSHIP_FILES.has(basename)) {
    return;
  }

  for (const rule of extractSelectorRules(text)) {
    for (const selector of rule.selectors) {
      if (!selectorOwners.has(selector)) {
        selectorOwners.set(selector, []);
      }
      selectorOwners.get(selector).push({ file, line: rule.line });
    }
  }
}

function checkDuplicateSelectorOwnership(selectorOwners) {
  for (const [selector, owners] of selectorOwners.entries()) {
    const files = new Set(owners.map((owner) => owner.file));
    if (files.size < 2) {
      continue;
    }
    const locations = owners
      .map((owner) => `${owner.file}:${owner.line}`)
      .join(", ");
    failures.push(`${locations}: duplicate selector ownership for ${selector}`);
  }
}

function checkUnsafeImportant(file, text) {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes("!important")) {
      continue;
    }
    if (hasNearbyReducedMotionMedia(lines, index)) {
      continue;
    }
    failures.push(`${file}:${index + 1}: !important is only allowed inside reduced-motion fallbacks`);
  }
}

function hasNearbyReducedMotionMedia(lines, index) {
  const start = Math.max(0, index - 12);
  return lines.slice(start, index + 1).some((line) =>
    line.includes("@media (prefers-reduced-motion: reduce)")
  );
}

function checkRedundantThemeSelectors(file, text) {
  for (const rule of extractSelectorRules(text)) {
    const selectors = rule.selectors;
    const selectorSet = new Set(selectors);
    for (const selector of selectors) {
      if (!selector.includes(':root[data-theme="dark"]')) {
        continue;
      }

      const neutralSelector = selector.replace(':root[data-theme="dark"]', ":root[data-theme]");
      if (selectorSet.has(neutralSelector)) {
        failures.push(`${file}:${rule.line}: redundant dark theme selector duplicates ${neutralSelector}`);
      }
    }
  }
}

function extractSelectorRules(text) {
  const rules = [];
  for (const match of text.matchAll(/([^{}]+)\{/g)) {
    const selectorGroup = match[1].trim();
    if (selectorGroup.length === 0 || selectorGroup.startsWith("@")) {
      continue;
    }
    const selectors = splitSelectorList(selectorGroup)
      .map((selector) => selector.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (selectors.length === 0) {
      continue;
    }
    rules.push({
      line: text.slice(0, match.index).split("\n").length,
      selectors
    });
  }
  return rules;
}

function splitSelectorList(selectorGroup) {
  const selectors = [];
  let current = "";
  let depth = 0;
  for (const character of selectorGroup) {
    if (character === "(" || character === "[") {
      depth += 1;
    } else if ((character === ")" || character === "]") && depth > 0) {
      depth -= 1;
    }
    if (character === "," && depth === 0) {
      selectors.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  selectors.push(current);
  return selectors;
}

function countMatches(text, pattern) {
  return text.split(pattern).length - 1;
}

function relativePath(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}
