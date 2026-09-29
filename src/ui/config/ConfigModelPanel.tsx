import type * as React from "react";
import type {
  ClaudeModelMapRole,
  ConfigProfileScope,
  PrimaryReasoningEffort,
  PublicConfig
} from "../../shared/types.js";
import { CustomSelect } from "../shared/CustomSelect.js";
import { ClaudeModelMapEditor } from "./ClaudeModelMapEditor.js";
import {
  primaryModelOptions,
  primaryReasoningOptions
} from "./primary-model-options.js";
import type { ConfigFormState } from "./types.js";
import { useUpstreamModels } from "./useUpstreamModels.js";

export function ConfigModelPanel({
  config,
  form,
  linkedCompactModel,
  onFormChange,
  onUnlockCompactModel,
  onRestoreLinkedMode,
  scope = "codex"
}: {
  config: PublicConfig | null;
  form: ConfigFormState;
  linkedCompactModel: string;
  onFormChange: React.Dispatch<React.SetStateAction<ConfigFormState>>;
  onUnlockCompactModel: () => void;
  onRestoreLinkedMode: () => void;
  scope?: ConfigProfileScope;
}) {
  // Track the actual catalogue connection, not every unrelated config save.
  // Credential changes are identified by the server without exposing secrets.
  const primarySourceKey = [
    config?.primary.model_source_revision ?? "loading",
    config?.profile_scopes.codex.active_profile_id ?? ""
  ].join("\n");
  const {
    models,
    fetchState,
    fetchMeta,
    fetchModels
  } = useUpstreamModels("/api/openai/models", primarySourceKey);

  function updateClaudeModelMap(role: ClaudeModelMapRole, value: string) {
    onFormChange((previous) => ({
      ...previous,
      claudeModelMap: {
        ...previous.claudeModelMap,
        [role]: value
      }
    }));
  }

  return (
    <div className="model-config-workspace">
      {scope === "codex" && <div className="model-config-grid">
        <section className="model-config-block model-primary-block" aria-labelledby="primary-model-title">
          <div className="model-config-block-head">
            <div>
              <p className="eyebrow">Codex Primary</p>
              <h3 id="primary-model-title">模型与思考强度</h3>
              <p>填写模型 ID，或拉取目录后选择；留空跟随客户端请求。</p>
            </div>
            <div className="model-config-actions">
              {models.length > 0 && <span className="map-counter">{models.length} 个模型</span>}
              <button
                type="button"
                className="btn btn-sm"
                disabled={fetchState === "loading"}
                onClick={() => void fetchModels()}
              >
                {fetchState === "loading" ? "读取中..." : "拉取模型"}
              </button>
            </div>
          </div>

          <p className="model-catalog-state" aria-live="polite">
            目录来源：{config?.primary.host || "等待配置"} · {fetchState === "idle" ? "尚未读取或连接已变化，请拉取模型" : fetchState === "loading" ? "正在读取已保存连接" : fetchState === "error" ? "读取失败，可继续手动输入" : "已读取已保存连接"}
          </p>

          {fetchMeta && (
            <p
              className={`model-fetch-note ${fetchState === "error" ? "is-error" : ""}`}
              aria-live="polite"
            >
              {fetchMeta}
            </p>
          )}

          {form.primaryReasoningEffort === "none" && (
            <p className="model-fetch-note is-legacy" aria-live="polite">
              当前仍保存旧值 none；请改为“跟随请求”或新的思考强度。
            </p>
          )}

          <label className="model-precision-field" htmlFor="primary-model-override">
            <span className="field-label">精确模型 ID</span>
            <input
              id="primary-model-override"
              className="input"
              value={form.primaryModelOverride}
              placeholder="留空则跟随客户端请求"
              onChange={(event) => onFormChange((previous) => ({
                ...previous,
                primaryModelOverride: event.target.value
              }))}
              spellCheck={false}
            />
            <span className="field-hint">可直接输入兼容上游的自定义模型；拉取列表不会覆盖旧值。</span>
          </label>

          <div className="primary-model-controls">
            {models.length > 0 && <CustomSelect
              label="上游模型"
              value={form.primaryModelOverride}
              options={primaryModelOptions(models, form.primaryModelOverride)}
              onChange={(primaryModelOverride) => onFormChange((previous) => ({ ...previous, primaryModelOverride }))}
              wide
            />}
            <CustomSelect
              label="思考强度"
              value={form.primaryReasoningEffort === "none" ? "" : form.primaryReasoningEffort}
              options={primaryReasoningOptions()}
              onChange={(primaryReasoningEffort) => onFormChange((previous) => ({
                ...previous,
                primaryReasoningEffort: primaryReasoningEffort as PrimaryReasoningEffort
              }))}
              wide
            />
          </div>
        </section>

        <section className="model-config-block model-compact-block" aria-labelledby="compact-model-title">
          <div className="model-config-block-head">
            <div>
              <p className="eyebrow">Compact Route</p>
              <h3 id="compact-model-title">压缩模型联动</h3>
              <p>仅用于 local/Remote V1 压缩；Remote V2 始终沿用 Primary 模型。</p>
            </div>
          </div>

          <div className="compact-model-mode">
            <span className="field-label">模型模式</span>
            <div className="toggle-group" role="group" aria-label="压缩模型模式">
              <button
                type="button"
                className={form.modelMode === "linked" ? "is-active" : ""}
                aria-pressed={form.modelMode === "linked"}
                onClick={onRestoreLinkedMode}
              >
                自动联动
              </button>
              <button
                type="button"
                className={form.modelMode === "custom" ? "is-active" : ""}
                aria-pressed={form.modelMode === "custom"}
                onClick={onUnlockCompactModel}
              >
                手动指定
              </button>
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="compact-model-target">目标模型</label>
            <div className="compact-model-control">
              <input
                id="compact-model-target"
                className="input"
                value={form.modelMode === "linked" ? linkedCompactModel : form.modelOverride}
                readOnly={form.modelMode === "linked"}
                onChange={(event) => onFormChange((previous) => ({
                  ...previous,
                  modelOverride: event.target.value
                }))}
                spellCheck={false}
              />
            </div>
          </div>

          <label className="field" htmlFor="compact-model-template" hidden={form.modelMode !== "linked"}>
            <span className="field-label">联动模板</span>
            <input
              id="compact-model-template"
              className="input"
              value={form.modelTemplate}
              onChange={(event) => onFormChange((previous) => ({
                ...previous,
                modelTemplate: event.target.value
              }))}
              spellCheck={false}
            />
            <span className="field-hint">{"{model}"} 替换为 Primary 覆盖模型；Primary 透传时使用请求模型。</span>
          </label>
        </section>
      </div>}

      {scope === "claude" && <ClaudeModelMapEditor
        modelMap={form.claudeModelMap}
        sourceLabel={config?.claude.primary.host || "等待配置"}
        sourceKey={[
          config?.claude.primary.model_source_revision ?? "loading",
          config?.profile_scopes.claude.active_profile_id ?? ""
        ].join("\n")}
        onModelMapChange={updateClaudeModelMap}
      />}
    </div>
  );
}
