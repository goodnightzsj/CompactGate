import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { errorSummary } from "../shared/api.js";
import {
  summarizeConfigImport,
  type ImportCandidate,
  type ImportState,
  type ImportSubmission
} from "./config-import-summary.js";
import { isRecord } from "../../shared/records.js";

export function useConfigImportWorkflow({
  onImportConfig
}: {
  onImportConfig: (payload: Record<string, unknown>) => void | Promise<void>;
}) {
  const [importCandidate, setImportCandidate] = useState<ImportCandidate | null>(null);
  const [importState, setImportState] = useState<ImportState>("idle");
  const [importError, setImportError] = useState<string | null>(null);
  const [importSubmission, setImportSubmission] = useState<ImportSubmission | null>(null);
  const selectionVersion = useRef(0);
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; selectionVersion.current++; };
  }, []);

  async function handleImportFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) {
      return;
    }

    const version = ++selectionVersion.current;
    setImportState("reading");
    setImportCandidate(null);
    setImportError(null);

    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isRecord(parsed)) {
        throw new Error("导入文件必须是 JSON 对象。");
      }
      validateImportCandidateShape(parsed);
      if (version !== selectionVersion.current) return;

      setImportCandidate({
        fileName: file.name,
        sizeBytes: file.size,
        config: parsed,
        summary: summarizeConfigImport(parsed)
      });
      setImportState("ready");
    } catch (error) {
      if (version !== selectionVersion.current) return;
      setImportCandidate(null);
      setImportState("error");
      setImportError(errorSummary(error));
    }
  }

  async function confirmImportConfig() {
    if (submitting.current) return;
    if (!importCandidate) {
      setImportState("error");
      setImportError("请先选择一个 compactgate JSON 配置文件。");
      return;
    }

    const version = selectionVersion.current;
    const fileName = importCandidate.fileName;
    submitting.current = true;
    setImportSubmission({ fileName, status: "pending" });
    setImportError(null);

    try {
      await onImportConfig(importCandidate.config);
      if (!mounted.current) return;
      setImportSubmission({ fileName, status: "success" });
      // Completing A must not clear a newer selection B.
      if (version === selectionVersion.current) {
        setImportCandidate(null);
        setImportState("idle");
      }
    } catch (error) {
      if (mounted.current) setImportSubmission({ fileName, status: "error", error: errorSummary(error) });
    } finally {
      submitting.current = false;
    }
  }

  function clearImportCandidate() {
    selectionVersion.current++;
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
    importSubmission,
    importState
  };
}


export function validateImportCandidateShape(config: Record<string, unknown>): void {
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
  validateOptionalPathType(config, ["listen"]);
  validateOptionalPathType(config, ["primary", "base_url"]);
  validateOptionalPathType(config, ["primary", "state_domain_id"]);
  validateOptionalPathType(config, ["compact", "base_url"]);
  validateOptionalPathType(config, ["claude", "primary", "base_url"]);
  validateOptionalPathType(config, ["logging", "redact_body"], "boolean");
  validateOptionalPathType(config, ["logging", "persist_body"], "boolean");
  validateOptionalPathType(config, ["logging", "keep_recent"], "number");
  validateOptionalPathType(config, ["logging", "capture_dir"], "nullable-string");
  validateOptionalPathType(config, ["logging", "capture_body_max_bytes"], "number");
  validateOptionalPathType(config, ["logging", "capture_dir_max_bytes"], "number");
  validateOptionalPathType(config, ["logging", "max_database_bytes"], "number");
  validateOptionalPathType(config, ["primary_failover", "auto_schedule"], "boolean");
  validateOptionalPathType(config, ["primary_failover", "state_portability"]);
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

function validateOptionalPathType(
  config: Record<string, unknown>,
  path: string[],
  expectedType: "string" | "number" | "boolean" | "nullable-string" = "string"
): void {
  let current: unknown = config;
  for (let index = 0; index < path.length; index += 1) {
    if (!isRecord(current) || !Object.hasOwn(current, path[index])) {
      return;
    }
    current = current[path[index]];
  }

  const valid =
    expectedType === "nullable-string"
      ? current === null || typeof current === "string"
      : typeof current === expectedType;
  if (!valid) {
    throw new Error(`导入字段 ${path.join(".")} 必须是 ${importTypeLabel(expectedType)}。`);
  }
}

function importTypeLabel(
  expectedType: "string" | "number" | "boolean" | "nullable-string"
): string {
  if (expectedType === "nullable-string") {
    return "字符串或 null";
  }
  if (expectedType === "string") {
    return "字符串";
  }

  return expectedType === "number" ? "数字" : "布尔值";
}
