import { createPortal } from "react-dom";
import type { PublicConfigProfile } from "./types.js";

export function ConfirmProfileDeleteDialog({
  profile,
  isDeleting,
  onCancel,
  onConfirm
}: {
  profile: PublicConfigProfile;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return createPortal(
    <div className="confirm-overlay" role="presentation">
      <section
        className="confirm-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-profile-delete-title"
        aria-describedby="confirm-profile-delete-desc"
      >
        <span className="confirm-icon" aria-hidden="true">!</span>
        <div className="confirm-copy">
          <p className="eyebrow">Delete Profile</p>
          <h2 id="confirm-profile-delete-title">删除配置档案“{profile.name}”？</h2>
          <p id="confirm-profile-delete-desc">
            这个操作只会删除 CompactGate 内保存的档案，不会删除当前运行时配置，也不会改动全局 Claude 或 Codex 配置文件。
          </p>
        </div>
        <div className="confirm-actions">
          <button className="ghost-button" type="button" disabled={isDeleting} onClick={onCancel}>
            取消
          </button>
          <button
            className="solid-button danger-solid-button"
            type="button"
            disabled={isDeleting}
            onClick={() => void onConfirm()}
          >
            {isDeleting ? "删除中..." : "确认删除"}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
