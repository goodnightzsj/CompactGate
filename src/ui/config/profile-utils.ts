import type { ConfigProfileScope, PublicConfig } from "../../shared/types.js";
import type { ProfileActionState } from "./types.js";

export function compactModeLabel(mode: "split" | "primary"): string {
  return mode === "split" ? "独立分流" : "复用主上游";
}

export function profileScopeState(config: PublicConfig, scope: ConfigProfileScope) {
  return config.profile_scopes?.[scope] ?? {
    profiles: scope === "codex" ? config.profiles : [],
    active_profile_id: scope === "codex" ? config.active_profile_id : null
  };
}

export function profileSummary(profile: PublicConfig["profiles"][number]): string {
  const secretCopy =
    profile.stored_api_key_count > 0
      ? `含 ${profile.stored_api_key_count} 个直填密钥`
      : "仅保存 URL 和环境变量引用";

  if (profile.scope === "claude") {
    const primaryModel = profile.claude_primary_model_override?.trim();
    return [
      `Claude ${profile.claude_primary_host ?? "未配置"}`,
      `主模型 ${primaryModel || "透传"}`,
      secretCopy
    ].join("；");
  }

  return [
    `Codex ${profile.primary_host ?? "未配置"} / ${profile.compact_host ?? "未配置"}`,
    `Codex compact ${compactModeLabel(profile.compact_upstream_mode ?? "primary")}`,
    secretCopy
  ].join("；");
}

export function profileActionLabel(state: ProfileActionState): string {
  switch (state) {
    case "saving":
      return "正在保存档案";
    case "saved":
      return "档案已保存";
    case "updating":
      return "正在更新档案";
    case "updated":
      return "档案已更新";
    case "reordering":
      return "正在保存排序";
    case "reordered":
      return "档案排序已保存";
    case "duplicating":
      return "正在复制档案";
    case "duplicated":
      return "档案已复制";
    case "deleting":
      return "正在删除档案";
    case "deleted":
      return "档案已删除";
    case "applying":
      return "正在应用档案";
    case "applied":
      return "档案已应用";
    case "error":
      return "档案操作失败";
    case "idle":
      return "档案操作就绪";
  }
}

export function isProfileActionBusy(state: ProfileActionState): boolean {
  return (
    state === "saving" ||
    state === "updating" ||
    state === "reordering" ||
    state === "duplicating" ||
    state === "deleting" ||
    state === "applying"
  );
}
