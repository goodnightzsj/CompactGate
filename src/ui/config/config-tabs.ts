import type { ConfigTab } from "./types.js";

export const DEFAULT_CONFIG_TAB: ConfigTab = "profiles";

export const CONFIG_TABS: Array<{ id: ConfigTab; label: string; title: string; description: string }> = [
  { id: "profiles", label: "档案", title: "配置档案", description: "管理可复用的连接与模型组合。选中只查看，应用后才会切换运行配置。" },
  { id: "routes", label: "连接与路由", title: "连接与路由", description: "配置上游地址、凭据与分流策略。Codex 与 Claude 分开编辑，底部统一保存。" },
  { id: "model", label: "模型", title: "模型与映射", description: "设置模型覆盖、压缩联动与 Claude 映射。模型目录来自已保存连接，草稿保存后生效。" },
  { id: "logging", label: "日志存储", title: "日志与存储", description: "平衡排障信息与存储占用。策略保存后生效；一次性正文清理需单独确认。" },
  { id: "portable", label: "备份与迁移", title: "备份与迁移", description: "选择要保留的配置版本，或核对文件后恢复。导入会整体替换运行配置与档案。" }
];

export function isConfigTab(value: string): value is ConfigTab {
  return CONFIG_TABS.some((tab) => tab.id === value);
}
