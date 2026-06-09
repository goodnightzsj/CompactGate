import type * as React from "react";
import type { ClaudeModelMapRole } from "../../shared/types.js";
import { ClaudeModelMapEditor } from "./ClaudeModelMapEditor.js";
import type { ConfigFormState } from "./types.js";

export function ConfigModelPanel({
  form,
  currentModel,
  linkedCompactModel,
  onCurrentModelChange,
  onFormChange,
  onUnlockCompactModel,
  onRestoreLinkedMode
}: {
  form: ConfigFormState;
  currentModel: string;
  linkedCompactModel: string;
  onCurrentModelChange: (model: string) => void;
  onFormChange: React.Dispatch<React.SetStateAction<ConfigFormState>>;
  onUnlockCompactModel: () => void;
  onRestoreLinkedMode: () => void;
}) {
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
    <div style={{ display: "grid", gap: 14 }}>
      <div className="field">
        <span className="field-label">当前 Codex 模型</span>
        <input
          className="input"
          value={currentModel}
          onChange={(event) => onCurrentModelChange(event.target.value)}
          spellCheck={false}
        />
        <span className="field-hint">可手动输入，也会从最近一次请求体自动学习。</span>
      </div>
      <ClaudeModelMapEditor
        modelMap={form.claudeModelMap}
        onModelMapChange={updateClaudeModelMap}
      />
      <div>
        <div className="field-label" style={{ marginBottom: 4 }}>压缩模型模式</div>
        <div className="toggle-group" style={{ marginBottom: 8 }}>
          <button
            type="button"
            className={form.modelMode === "linked" ? "is-active" : ""}
            onClick={onRestoreLinkedMode}
          >
            自动联动
          </button>
          <button
            type="button"
            className={form.modelMode === "custom" ? "is-active" : ""}
            onClick={onUnlockCompactModel}
          >
            手动指定
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
          <input
            className="input"
            value={form.modelMode === "linked" ? linkedCompactModel : form.modelOverride}
            readOnly={form.modelMode === "linked"}
            onChange={(event) => onFormChange((previous) => ({ ...previous, modelOverride: event.target.value }))}
            spellCheck={false}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={form.modelMode === "linked" ? onUnlockCompactModel : onRestoreLinkedMode}
          >
            {form.modelMode === "linked" ? "解锁" : "恢复联动"}
          </button>
        </div>
      </div>
      <div className="field">
        <span className="field-label">压缩模型联动模板</span>
        <input
          className="input"
          value={form.modelTemplate}
          onChange={(event) => onFormChange((previous) => ({ ...previous, modelTemplate: event.target.value }))}
          spellCheck={false}
        />
        <span className="field-hint">{"{model}"} 会被替换为请求中的原始模型名。</span>
      </div>
    </div>
  );
}
