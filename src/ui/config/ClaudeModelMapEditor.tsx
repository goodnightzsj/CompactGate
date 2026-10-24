import { useId, useState } from "react";
import type { ClaudeModelMap, ClaudeModelMapRole } from "../../shared/types.js";
import { CustomSelect, type SelectOption } from "../shared/CustomSelect.js";
import { CLAUDE_MODEL_MAP_META, CLAUDE_MODEL_MAP_ROLES, normalizeClaudeModelMap } from "./model-map.js";
import { useUpstreamModels } from "./useUpstreamModels.js";

const CUSTOM_MODEL_OPTION_VALUE = "__custom_model__";

export function ClaudeModelMapEditor({
  modelMap,
  sourceKey,
  sourceLabel,
  onModelMapChange
}: {
  modelMap: ClaudeModelMap;
  sourceKey: string;
  sourceLabel: string;
  onModelMapChange: (patch: Partial<ClaudeModelMap>) => void;
}) {
  const inputIdPrefix = useId();
  const [bulkChoice, setBulkChoice] = useState<{
    catalogue: string[];
    role: ClaudeModelMapRole;
    model: string;
    status: "pending" | "applied" | "dismissed";
  } | null>(null);
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
  // A refetch or source change invalidates the offer along with its catalogue.
  const activeChoice = fetchState === "loaded" && bulkChoice?.catalogue === models &&
    normalizedModelMap[bulkChoice.role] === bulkChoice.model ? bulkChoice : null;

  function changeModel(role: ClaudeModelMapRole, model: string, fromCatalogue = false) {
    onModelMapChange({ [role]: model });
    if (fromCatalogue && fetchState === "loaded" && bulkChoice?.catalogue !== models) {
      setBulkChoice({ catalogue: models, role, model, status: "pending" });
    } else if (bulkChoice) {
      setBulkChoice({ ...bulkChoice, status: "dismissed" });
    }
  }

  function finishBulkChoice(status: "applied" | "dismissed") {
    if (!activeChoice) return;
    if (status === "applied") {
      onModelMapChange(Object.fromEntries(CLAUDE_MODEL_MAP_ROLES.map((role) => [role, activeChoice.model])));
    }
    setBulkChoice({ ...activeChoice, status });
    document.getElementById(`${inputIdPrefix}-${activeChoice.role}`)?.focus({ preventScroll: true });
  }

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

      <p className="model-catalog-state" aria-live="polite">
        目录来源：{sourceLabel} · {fetchState === "idle" ? "尚未读取或连接已变化，请拉取模型" : fetchState === "loading" ? "正在读取已保存连接" : fetchState === "error" ? "读取失败，可继续手动输入" : "已读取已保存连接"}
      </p>

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
                  onChange={(event) => changeModel(role, event.target.value)}
                  spellCheck={false}
                />
                {models.length > 0 && <CustomSelect
                  label="候选模型"
                  value={selectValue}
                  options={modelOptions}
                  onChange={(nextModel) => {
                    if (nextModel !== CUSTOM_MODEL_OPTION_VALUE) {
                      changeModel(role, nextModel, true);
                    } else if (bulkChoice) {
                      setBulkChoice({ ...bulkChoice, status: "dismissed" });
                    }
                  }}
                  disabled={models.length === 0}
                  compact
                  wide
                />}
              </div>
              <small className="model-row-hint">{meta.hint}</small>
              {activeChoice?.role === role && activeChoice.status === "pending" && (
                <div className="model-bulk-offer" role="group" aria-labelledby={`${inputId}-bulk-title`}
                  aria-describedby={`${inputId}-bulk-note`}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") finishBulkChoice("dismissed");
                  }}>
                  <div className="model-bulk-heading" role="status">
                    <h4 id={`${inputId}-bulk-title`}>全部槽位使用这个模型？</h4>
                    <span className="model-bulk-optional">可选</span>
                  </div>
                  <div className="model-bulk-preview">
                    <p className="model-bulk-model">{activeChoice.model}</p>
                    <ul className="model-bulk-roles" aria-label="将应用的 6 个槽位">
                      {CLAUDE_MODEL_MAP_ROLES.map((targetRole) => (
                        <li key={targetRole}>{CLAUDE_MODEL_MAP_META[targetRole].label}</li>
                      ))}
                    </ul>
                  </div>
                  <p className="model-bulk-note" id={`${inputId}-bulk-note`}>
                    将覆盖其他槽位的当前值。<span>仅更新草稿，保存配置后生效。</span>
                  </p>
                  <div className="model-bulk-actions">
                    <button type="button" className="btn btn-primary" onClick={() => finishBulkChoice("applied")}>
                      应用到全部 6 个槽位
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => finishBulkChoice("dismissed")}>
                      仅此槽位
                    </button>
                  </div>
                </div>
              )}
              {activeChoice?.role === role && activeChoice.status === "applied" && (
                <p className="model-bulk-result" role="status">
                  <span aria-hidden="true">✓</span> 已填入全部 6 个槽位，保存配置后生效。仍可逐项调整。
                </p>
              )}
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
