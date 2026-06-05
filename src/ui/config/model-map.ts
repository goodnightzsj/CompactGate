import type { ClaudeModelMap, ClaudeModelMapRole } from "../../shared/types.js";

export const CLAUDE_MODEL_MAP_ROLES: ClaudeModelMapRole[] = [
  "default",
  "opus",
  "sonnet",
  "haiku",
  "reasoning",
  "subagent"
];

export const CLAUDE_MODEL_MAP_META: Record<
  ClaudeModelMapRole,
  { label: string; source: string; hint: string; official: boolean }
> = {
  default: {
    label: "默认",
    source: "ANTHROPIC_MODEL / default / best",
    hint: "普通 Claude Code 会话和无法识别具体角色的请求都会落到这里。",
    official: true
  },
  opus: {
    label: "Opus 高能力",
    source: "ANTHROPIC_DEFAULT_OPUS_MODEL / opus / opusplan",
    hint: "用于高能力模型槽位，Plan Mode 的 Opus 路径也会优先匹配这里。",
    official: true
  },
  sonnet: {
    label: "Sonnet 均衡",
    source: "ANTHROPIC_DEFAULT_SONNET_MODEL / sonnet",
    hint: "用于 Claude Code 的均衡主力模型槽位。",
    official: true
  },
  haiku: {
    label: "Haiku 快速",
    source: "ANTHROPIC_DEFAULT_HAIKU_MODEL / haiku",
    hint: "用于小模型、快速任务和部分后台功能。",
    official: true
  },
  reasoning: {
    label: "推理",
    source: "ANTHROPIC_REASONING_MODEL",
    hint: "cc-switch 兼容槽位；官方 Claude Code 文档未把它列为标准环境变量。",
    official: false
  },
  subagent: {
    label: "子代理",
    source: "CLAUDE_CODE_SUBAGENT_MODEL / subagent",
    hint: "用于子代理和 agent teams；设置为 inherit 的场景建议留空。",
    official: true
  }
};

export function emptyClaudeModelMap(): ClaudeModelMap {
  return CLAUDE_MODEL_MAP_ROLES.reduce((modelMap, role) => {
    modelMap[role] = "";
    return modelMap;
  }, {} as ClaudeModelMap);
}

export function normalizeClaudeModelMap(value: Partial<ClaudeModelMap> | null | undefined): ClaudeModelMap {
  const modelMap = emptyClaudeModelMap();
  if (!value || typeof value !== "object") {
    return modelMap;
  }

  for (const role of CLAUDE_MODEL_MAP_ROLES) {
    const model = value[role];
    modelMap[role] = typeof model === "string" ? model : "";
  }

  return modelMap;
}
