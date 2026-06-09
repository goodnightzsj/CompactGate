import type { ConfigProfileScope } from "../shared/types.js";

export const PROFILE_SCOPES: ConfigProfileScope[] = ["codex", "claude"];

export function normalizeProfileOperationArgs(
  scopeOrName: ConfigProfileScope | string,
  nameOrPatch: string | unknown,
  maybePatch?: unknown
): { scope: ConfigProfileScope; name: string; patch: unknown } {
  if (isProfileScope(scopeOrName) && typeof nameOrPatch === "string") {
    return { scope: scopeOrName, name: nameOrPatch, patch: maybePatch ?? {} };
  }

  return { scope: "codex", name: scopeOrName, patch: nameOrPatch ?? {} };
}

export function normalizeProfileMutationArgs(
  scopeOrProfileId: ConfigProfileScope | string,
  profileIdOrName: string | undefined,
  nameOrPatch?: string | unknown,
  maybePatch?: unknown
): { scope: ConfigProfileScope; profileId: string; name: string | undefined; patch: unknown } {
  if (isProfileScope(scopeOrProfileId)) {
    return {
      scope: scopeOrProfileId,
      profileId: profileIdOrName ?? "",
      name: typeof nameOrPatch === "string" ? nameOrPatch : undefined,
      patch: maybePatch ?? (typeof nameOrPatch === "string" ? {} : nameOrPatch ?? {})
    };
  }

  return {
    scope: "codex",
    profileId: scopeOrProfileId,
    name: profileIdOrName,
    patch: nameOrPatch ?? {}
  };
}

export function normalizeProfileIdNameArgs(
  scopeOrProfileId: ConfigProfileScope | string,
  profileIdOrName?: string,
  maybeName?: string
): { scope: ConfigProfileScope; profileId: string; name: string | undefined } {
  if (isProfileScope(scopeOrProfileId)) {
    return { scope: scopeOrProfileId, profileId: profileIdOrName ?? "", name: maybeName };
  }

  return { scope: "codex", profileId: scopeOrProfileId, name: profileIdOrName };
}

export function normalizeProfileIdArgs(
  scopeOrProfileId: ConfigProfileScope | string,
  maybeProfileId?: string
): { scope: ConfigProfileScope; profileId: string } {
  if (isProfileScope(scopeOrProfileId)) {
    return { scope: scopeOrProfileId, profileId: maybeProfileId ?? "" };
  }

  return { scope: "codex", profileId: scopeOrProfileId };
}

export function isProfileScope(value: string): value is ConfigProfileScope {
  return value === "codex" || value === "claude";
}
