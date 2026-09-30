import { useCallback } from "react";
import type { PublicConfigProfile } from "./types.js";

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
  const openAsModal = useCallback((node: HTMLDialogElement | null) => {
    const trigger = document.activeElement;
    node?.showModal();
    return () => {
      node?.close();
      // Successful deletion removes the trigger before this ref is cleaned up.
      // The scope's name field remains available even after its last profile.
      if (trigger && !trigger.isConnected) {
        document.getElementById(`${profile.scope}-profile-name`)?.focus({ preventScroll: true });
      }
    };
  }, [profile.scope]);

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
      <div role="alert">{error && <p className="error-note">{error}</p>}</div>
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
