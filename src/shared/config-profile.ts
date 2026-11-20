import type { CompactGateRuntimeConfig, ConfigProfileScope, SavedClaudeProfileConfig, SavedCodexProfileConfig } from "./types.js";

export function extractScopedProfileConfig(
  runtime: CompactGateRuntimeConfig,
  scope: ConfigProfileScope
): SavedCodexProfileConfig | SavedClaudeProfileConfig {
  if (scope === "codex") {
    return { primary: { ...runtime.primary }, compact: { ...runtime.compact } };
  }
  return {
    claude: {
      primary: { ...runtime.claude.primary },
      compact: { ...runtime.claude.compact },
      model_map: { ...runtime.claude.model_map },
      scene_map: structuredClone(runtime.claude.scene_map),
      long_context_bytes: runtime.claude.long_context_bytes
    }
  };
}
