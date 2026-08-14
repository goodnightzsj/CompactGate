import { useState } from "react";
import { createPortal } from "react-dom";
import type { ConfigProfileScope } from "../../shared/types.js";
import type { PublicConfigProfile } from "./types.js";

export function ConfirmProfileOverwriteDialog({
  scope,
  profile,
  suggestedName,
  existingNames,
  onCancel,
  onOverwrite,
  onSaveAsNew
}: {
  scope: ConfigProfileScope;
  profile: PublicConfigProfile;
  suggestedName: string;
  existingNames: string[];
  onCancel: () => void;
  onOverwrite: () => Promise<boolean>;
  onSaveAsNew: (name: string) => Promise<boolean>;
}) {
  const [newName, setNewName] = useState(suggestedName);
  const [submitting, setSubmitting] = useState(false);
  const trimmedName = newName.trim();
  const nameTaken = existingNames.some((name) => name === trimmedName);
  const scopeLabel = scope === "codex" ? "Codex" : "Claude";

  async function run(action: "overwrite" | "save-as-new") {
    setSubmitting(true);
    const ok = action === "overwrite"
      ? await onOverwrite()
      : await onSaveAsNew(trimmedName);
    if (!ok) {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div className="confirm-overlay" role="presentation">
      <section
        className="confirm-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-profile-overwrite-title"
        aria-describedby="confirm-profile-overwrite-desc"
      >
        <span className="confirm-icon" aria-hidden="true">!</span>
        <div className="confirm-copy">
          <p className="eyebrow">Profile Name Taken</p>
          <h2 id="confirm-profile-overwrite-title">档案「{profile.name}」已存在</h2>
          <p id="confirm-profile-overwrite-desc">
            这个名字已被 {scopeLabel} 里另一个未选中的档案占用。保存到它会覆盖该档案当前内容，不会切换当前运行时；也可以改个新名字另存为新档案。
          </p>
        </div>
        <div className="confirm-overwrite-name">
          <span className="confirm-field-label">另存为新档案名称</span>
          <input
            aria-label="另存为新档案名称"
            value={newName}
            disabled={submitting}
            onChange={(event) => setNewName(event.target.value)}
          />
          {nameTaken && <small className="confirm-field-error">已有同名档案，请换个名字。</small>}
        </div>
        <div className="confirm-actions">
          <button className="ghost-button" type="button" disabled={submitting} onClick={onCancel}>
            取消
          </button>
          <button
            className="ghost-button"
            type="button"
            disabled={submitting || !trimmedName || nameTaken}
            onClick={() => void run("save-as-new")}
          >
            {submitting ? "保存中..." : "另存为新档案"}
          </button>
          <button
            className="solid-button danger-solid-button"
            type="button"
            disabled={submitting}
            onClick={() => void run("overwrite")}
          >
            {submitting ? "保存中..." : `覆盖档案「${profile.name}」`}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
