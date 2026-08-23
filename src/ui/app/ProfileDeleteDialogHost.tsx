import { ConfirmProfileDeleteDialog } from "../config/ConfirmProfileDeleteDialog.js";
import type { ProfileActionState, ProfileDeleteCandidate } from "../config/types.js";

export type ProfileDeleteDialogHostProps = {
  candidate: ProfileDeleteCandidate | null;
  claudeProfileError: string | null;
  claudeProfileState: ProfileActionState;
  codexProfileError: string | null;
  codexProfileState: ProfileActionState;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

export function ProfileDeleteDialogHost({
  candidate,
  claudeProfileError,
  claudeProfileState,
  codexProfileError,
  codexProfileState,
  onCancel,
  onConfirm
}: ProfileDeleteDialogHostProps) {
  if (!candidate) {
    return null;
  }

  const isCodex = candidate.scope === "codex";
  const isDeleting = (isCodex ? codexProfileState : claudeProfileState) === "deleting";

  return (
    <ConfirmProfileDeleteDialog
      profile={candidate.profile}
      isDeleting={isDeleting}
      error={isCodex ? codexProfileError : claudeProfileError}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
