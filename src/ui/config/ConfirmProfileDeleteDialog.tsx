import type { PublicConfigProfile } from "./types.js";

// Stable identity: an inline arrow would re-attach (and re-open) on every render.
function openAsModal(node: HTMLDialogElement | null): void {
  node?.showModal();
}

export function ConfirmProfileDeleteDialog({
  profile,
  isDeleting,
  error,
  onCancel,
  onConfirm
}: {
  profile: PublicConfigProfile;
  isDeleting: boolean;
  /**
   * A refused delete only re-enables the button, and this dialog is mounted at
   * app level — so outside the profiles tab there was nothing on screen that
   * could say why the profile is still there.
   */
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <dialog
      ref={openAsModal}
      className="confirm-panel"
      role="alertdialog"
      aria-labelledby="confirm-profile-delete-title"
      aria-describedby="confirm-profile-delete-desc"
      onCancel={(event) => {
        event.preventDefault();
        if (!isDeleting) {
          onCancel();
        }
      }}
    >
      <span className="confirm-icon" aria-hidden="true">!</span>
      <div className="confirm-copy">
        <p className="eyebrow">Delete Profile</p>
        <h2 id="confirm-profile-delete-title">删除配置档案“{profile.name}”？</h2>
        <p id="confirm-profile-delete-desc">
          这个操作只会删除 CompactGate 内保存的档案，不会删除当前运行时配置，也不会改动全局 Claude 或 Codex 配置文件。
        </p>
      </div>
      {error && <p className="error-note">{error}</p>}
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
    </dialog>
  );
}
