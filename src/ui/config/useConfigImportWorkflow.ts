import { useState } from "react";
import type * as React from "react";
import { errorSummary } from "../shared/api.js";
import {
  summarizeConfigImport,
  type ImportCandidate,
  type ImportState
} from "./config-import-summary.js";

export function useConfigImportWorkflow({
  onImportConfig
}: {
  onImportConfig: (payload: Record<string, unknown>) => void | Promise<void>;
}) {
  const [importCandidate, setImportCandidate] = useState<ImportCandidate | null>(null);
  const [importState, setImportState] = useState<ImportState>("idle");
  const [importError, setImportError] = useState<string | null>(null);

  async function handleImportFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) {
      return;
    }

    setImportState("idle");
    setImportError(null);

    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isRecord(parsed)) {
        throw new Error("导入文件必须是 JSON 对象。");
      }
      validateImportCandidateShape(parsed);

      setImportCandidate({
        fileName: file.name,
        sizeBytes: file.size,
        config: parsed,
        summary: summarizeConfigImport(parsed)
      });
      setImportState("ready");
    } catch (error) {
      setImportCandidate(null);
      setImportState("error");
      setImportError(errorSummary(error));
    }
  }

  async function confirmImportConfig() {
    if (!importCandidate) {
      setImportState("error");
      setImportError("请先选择一个 compactgate JSON 配置文件。");
      return;
    }

    setImportState("importing");
    setImportError(null);

    try {
      await onImportConfig(importCandidate.config);
      setImportState("imported");
    } catch (error) {
      setImportState("error");
      setImportError(errorSummary(error));
    }
  }

  function clearImportCandidate() {
    setImportCandidate(null);
    setImportState("idle");
    setImportError(null);
  }

  return {
    clearImportCandidate,
    confirmImportConfig,
    handleImportFileChange,
    importCandidate,
    importError,
    importState
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateImportCandidateShape(config: Record<string, unknown>): void {
  const knownTopLevelKeys = [
    "listen",
    "primary",
    "compact",
    "claude",
    "timeouts",
    "logging",
    "primary_failover",
    "profiles",
    "active_profile_id",
    "profile_scopes",
    "route_url_presets"
  ];
  if (!knownTopLevelKeys.some((key) => Object.hasOwn(config, key))) {
    throw new Error("导入文件缺少 CompactGate 配置字段。");
  }

  validateOptionalRecord(config, "primary");
  validateOptionalRecord(config, "compact");
  validateOptionalRecord(config, "claude");
  validateOptionalRecord(config, "timeouts");
  validateOptionalRecord(config, "logging");
  validateOptionalRecord(config, "primary_failover");
  validateOptionalRecord(config, "profile_scopes");
  validateOptionalArray(config, "profiles");
  validateOptionalArray(config, "route_url_presets");
  validateOptionalStringPath(config, ["listen"]);
  validateOptionalStringPath(config, ["primary", "base_url"]);
  validateOptionalStringPath(config, ["compact", "base_url"]);
  validateOptionalStringPath(config, ["claude", "primary", "base_url"]);
  validateOptionalStringPath(config, ["logging", "keep_recent"], "number");
  validateOptionalStringPath(config, ["logging", "persist_body"], "boolean");
  validateOptionalStringPath(config, ["primary_failover", "auto_schedule"], "boolean");
}

function validateOptionalRecord(config: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(config, key) && !isRecord(config[key])) {
    throw new Error(`导入字段 ${key} 必须是 JSON 对象。`);
  }
}

function validateOptionalArray(config: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(config, key) && !Array.isArray(config[key])) {
    throw new Error(`导入字段 ${key} 必须是数组。`);
  }
}

function validateOptionalStringPath(
  config: Record<string, unknown>,
  path: string[],
  expectedType: "string" | "number" | "boolean" = "string"
): void {
  let current: unknown = config;
  for (let index = 0; index < path.length; index += 1) {
    if (!isRecord(current) || !Object.hasOwn(current, path[index])) {
      return;
    }
    current = current[path[index]];
  }

  if (typeof current !== expectedType) {
    throw new Error(`导入字段 ${path.join(".")} 必须是 ${importTypeLabel(expectedType)}。`);
  }
}

function importTypeLabel(expectedType: "string" | "number" | "boolean"): string {
  if (expectedType === "string") {
    return "字符串";
  }

  return expectedType === "number" ? "数字" : "布尔值";
}
