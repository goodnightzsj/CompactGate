import type { ConfigTab } from "./types.js";

export const DEFAULT_CONFIG_TAB: ConfigTab = "profiles";

export const CONFIG_TABS: Array<{ id: ConfigTab; label: string }> = [
  { id: "profiles", label: "档案" },
  { id: "routes", label: "连接与路由" },
  { id: "model", label: "模型" },
  { id: "logging", label: "日志存储" },
  { id: "portable", label: "备份与迁移" }
];

export function isConfigTab(value: string): value is ConfigTab {
  return CONFIG_TABS.some((tab) => tab.id === value);
}
