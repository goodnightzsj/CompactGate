import { useState } from "react";
import type { ConfigProfileScope, PublicConfig } from "../../shared/types.js";
import { profileScopeState } from "./profile-utils.js";

// Stable identity: an inline arrow would re-attach (and re-open) on every render.
function openAsModal(node: HTMLDialogElement | null): void {
  node?.showModal();
}

export function ConfigSaveAsNewProfileDialog({
  config,
  onCancel,
  onConfirm
}: {
  config: PublicConfig | null;
  onCancel: () => void;
  onConfirm: (scope: ConfigProfileScope, name: string) => void | Promise<boolean>;
}) {
  const [scope, setScope] = useState<ConfigProfileScope>("codex");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const trimmedName = name.trim();
  const existingNames = config
    ? new Set(profileScopeState(config, scope).profiles.map((profile) => profile.name))
    : new Set<string>();
  const nameTaken = trimmedName.length > 0 && existingNames.has(trimmedName);
  const scopeLabel = scope === "codex" ? "Codex" : "Claude";

  async function handleConfirm() {
    if (!trimmedName || nameTaken) {
      return;
    }

    setSubmitting(true);
    const ok = await onConfirm(scope, trimmedName);
    if (!ok) {
      setSubmitting(false);
    }
  }

  return (
    <dialog
      ref={openAsModal}
      className="confirm-panel"
      aria-labelledby="config-save-as-new-title"
      aria-describedby="config-save-as-new-desc"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting) {
          onCancel();
        }
      }}
    >
      <span className="confirm-icon confirm-icon-neutral" aria-hidden="true">+</span>
      <div className="confirm-copy">
        <p className="eyebrow">Save As New Profile</p>
        <h2 id="config-save-as-new-title">另存为新档案</h2>
        <p id="config-save-as-new-desc">
          把当前表单草稿保存为一个新的配置档案。不会改动已有档案，也不会切换当前运行时。
        </p>
      </div>
      <div className="scope-toggle-row" role="radiogroup" aria-label="档案作用域">
        {(["codex", "claude"] as const).map((candidate) => (
          <button
            key={candidate}
            className={`ghost-button${scope === candidate ? " is-active" : ""}`}
            type="button"
            role="radio"
            aria-checked={scope === candidate}
            disabled={submitting}
            onClick={() => setScope(candidate)}
          >
            {candidate === "codex" ? "Codex 档案" : "Claude 档案"}
          </button>
        ))}
      </div>
      <div className="confirm-overwrite-name">
        <span className="confirm-field-label">新档案名称</span>
        <input
          aria-label="新档案名称"
          value={name}
          disabled={submitting}
          placeholder={`例如：${scopeLabel} 正式环境`}
          onChange={(event) => setName(event.target.value)}
        />
        {nameTaken && <small className="confirm-field-error">{scopeLabel} 已有同名档案，请换个名字。</small>}
      </div>
      <div className="confirm-actions">
        <button className="ghost-button" type="button" disabled={submitting} onClick={onCancel}>
          取消
        </button>
        <button
          className="solid-button"
          type="button"
          disabled={submitting || !trimmedName || nameTaken}
          onClick={() => void handleConfirm()}
        >
          {submitting ? "保存中..." : "保存为新档案"}
        </button>
      </div>
    </dialog>
  );
}
