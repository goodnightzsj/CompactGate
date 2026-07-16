import { useId } from "react";
import type { ClaudeModelMap, ClaudeModelMapRole } from "../../shared/types.js";
import { CustomSelect, type SelectOption } from "../shared/CustomSelect.js";
import { CLAUDE_MODEL_MAP_META, CLAUDE_MODEL_MAP_ROLES, normalizeClaudeModelMap } from "./model-map.js";
import { useUpstreamModels } from "./useUpstreamModels.js";

const CUSTOM_MODEL_OPTION_VALUE = "__custom_model__";

export function ClaudeModelMapEditor({
  modelMap,
  sourceKey,
  onModelMapChange
}: {
  modelMap: ClaudeModelMap;
  sourceKey: string;
  onModelMapChange: (role: ClaudeModelMapRole, value: string) => void;
}) {
  const inputIdPrefix = useId();
  const {
    models,
    fetchState,
    fetchMeta,
    fetchModels
  } = useUpstreamModels("/api/claude/models", sourceKey);

  const normalizedModelMap = normalizeClaudeModelMap(modelMap);
  const filledCount = CLAUDE_MODEL_MAP_ROLES.filter((role) => normalizedModelMap[role].trim().length > 0).length;
  const fallbackModel = normalizedModelMap.default.trim();
  const modelOptions = buildClaudeModelOptions(models);

  return (
    <section className="claude-model-map-card" aria-labelledby="claude-model-map-title">
      <div className="claude-model-map-head">
        <div>
          <p className="eyebrow">Claude 模型映射</p>
          <h3 id="claude-model-map-title">Claude 角色模型映射</h3>
          <p>
            模型目录读取已保存的 Claude Primary 上游；这里可覆盖普通会话、Opus、Sonnet、Haiku、推理和子代理的目标模型。
            未识别的请求会回退到默认槽位。
          </p>
        </div>
        <div className="claude-model-map-actions">
          <span className="map-counter">{filledCount}/6 已设置</span>
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

      {fetchMeta && (
        <p
          className={`model-fetch-note ${fetchState === "error" ? "is-error" : ""}`}
          aria-live="polite"
        >
          {fetchMeta}
        </p>
      )}

      <div className="claude-model-map-grid">
        {CLAUDE_MODEL_MAP_ROLES.map((role) => {
          const meta = CLAUDE_MODEL_MAP_META[role];
          const value = normalizedModelMap[role];
          const inheritsDefault = role !== "default" && value.trim().length === 0 && fallbackModel.length > 0;
          const selectValue = models.includes(value) ? value : CUSTOM_MODEL_OPTION_VALUE;
          const inputId = `${inputIdPrefix}-${role}`;

          return (
            <div key={role} className={`claude-model-map-row ${role === "default" ? "is-default" : ""}`}>
              <span className="model-role-cell">
                <label htmlFor={inputId}>{meta.label}</label>
                <small>{meta.source}</small>
              </span>
              <span className="model-kind-cell">
                <span className={`tag ${meta.official ? "" : "is-compat"}`}>
                  {meta.official ? "官方" : "兼容"}
                </span>
                {inheritsDefault && <span className="tag is-fallback">回退默认</span>}
              </span>
              <div className="model-control-cell">
                <input
                  id={inputId}
                  aria-label={`Claude ${meta.label} 模型`}
                  className="input"
                  value={value}
                  placeholder={role === "default" ? "例如 claude-sonnet-4-6" : fallbackModel || "留空则使用默认槽位"}
                  onChange={(event) => onModelMapChange(role, event.target.value)}
                  spellCheck={false}
                />
                <CustomSelect
                  label="候选模型"
                  value={selectValue}
                  options={modelOptions}
                  onChange={(nextModel) => {
                    if (nextModel !== CUSTOM_MODEL_OPTION_VALUE) {
                      onModelMapChange(role, nextModel);
                    }
                  }}
                  disabled={models.length === 0}
                  compact
                  wide
                />
              </div>
              <small className="model-row-hint">{meta.hint}</small>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function buildClaudeModelOptions(models: string[]): SelectOption[] {
  return [
    {
      value: CUSTOM_MODEL_OPTION_VALUE,
      label: models.length > 0 ? "手动输入" : "拉取后选择",
      meta: models.length > 0 ? "保留当前手动填写值" : "先点击上方“拉取模型”"
    },
    ...models.map((model) => ({
      value: model,
      label: model,
      meta: "来自当前 Claude 上游"
    }))
  ];
}
