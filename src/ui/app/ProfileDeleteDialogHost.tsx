import { ConfirmProfileDeleteDialog } from "../config/ConfirmProfileDeleteDialog.js";
import type { ProfileActionState, ProfileDeleteCandidate } from "../config/types.js";

export type ProfileDeleteDialogHostProps = {
  candidate: ProfileDeleteCandidate | null;
  claudeProfileState: ProfileActionState;
  codexProfileState: ProfileActionState;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

export function ProfileDeleteDialogHost({
  candidate,
  claudeProfileState,
  codexProfileState,
  onCancel,
  onConfirm
}: ProfileDeleteDialogHostProps) {
  if (!candidate) {
    return null;
  }

  const isDeleting =
    (candidate.scope === "codex" ? codexProfileState : claudeProfileState) === "deleting";

  return (
    <ConfirmProfileDeleteDialog
      profile={candidate.profile}
      isDeleting={isDeleting}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
