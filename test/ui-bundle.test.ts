import { build } from "vite";
import { expect, it } from "vitest";

it("keeps secondary pages out of the initial bundle and all chunks below the warning limit", async () => {
  const result = await build({ logLevel: "silent", build: { write: false } });
  if (Array.isArray(result) || !("output" in result)) throw new Error("Expected one browser build");
  const chunks = result.output.filter((output) => output.type === "chunk");
  const entry = chunks.find((chunk) => chunk.isEntry);
  expect(entry).toBeDefined();
  const initial = new Set<string>();
  const visit = (fileName: string) => {
    if (initial.has(fileName)) return;
    initial.add(fileName);
    for (const dependency of chunks.find((chunk) => chunk.fileName === fileName)?.imports ?? []) visit(dependency);
  };
  visit(entry!.fileName);
  const initialModules = chunks.filter((chunk) => initial.has(chunk.fileName)).flatMap((chunk) => chunk.moduleIds);
  expect(chunks.some((chunk) => chunk.name === "react-vendor" && initial.has(chunk.fileName))).toBe(true);
  expect(initialModules.some((id) => id.endsWith("/dashboard/DashboardPage.tsx"))).toBe(true);
  for (const page of ["ConfigPage", "LogsPage", "RoutesPage", "HealthPage", "AnalyticsDashboardPage", "UsageAnalyticsPage"]) {
    expect(initialModules.some((id) => id.endsWith(`/${page}.tsx`)), page).toBe(false);
    expect(chunks.some((chunk) => chunk.isDynamicEntry && chunk.moduleIds.some((id) => id.endsWith(`/${page}.tsx`))), page).toBe(true);
  }
  for (const chunk of chunks) expect(Buffer.byteLength(chunk.code), chunk.fileName).toBeLessThan(500_000);
}, 20_000);
