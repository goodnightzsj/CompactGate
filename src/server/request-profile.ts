import type { IncomingHttpHeaders } from "node:http";
import type {
  CompactGateConfig,
  ConfigProfileScope
} from "../shared/types.js";
import { ConfigError } from "./config-internals.js";
import { applyProfile } from "./config-profile-mutations.js";
import { getProfileScopeState } from "./config-profile-scope.js";
import { readHeaderString } from "./http-utils.js";

export const REQUEST_PROFILE_HEADER = "x-compactgate-profile";

export interface RequestScopedProfile {
  config: CompactGateConfig;
  profileId: string;
  profileName: string;
  source: "explicit";
}

export function resolveRequestScopedProfile(
  config: CompactGateConfig,
  scope: ConfigProfileScope,
  headers: IncomingHttpHeaders,
  remoteAddress: string | undefined
): RequestScopedProfile | null {
  const profileId = readHeaderString(headers[REQUEST_PROFILE_HEADER]);
  if (!profileId) {
    return null;
  }
  if (!isLoopbackAddress(remoteAddress)) {
    throw new ConfigError("x-compactgate-profile is accepted only from loopback clients.");
  }

  const profile = getProfileScopeState(config, scope).profiles.find(
    (candidate) => candidate.id === profileId
  );
  if (!profile) {
    throw new ConfigError(`Profile not found: ${profileId}.`);
  }

  const selected = applyProfile(config, scope, profileId);
  return {
    config: scope === "codex"
      ? {
          ...selected,
          primary_failover: {
            ...selected.primary_failover,
            auto_schedule: false
          }
        }
      : selected,
    profileId,
    profileName: profile.name,
    source: "explicit"
  };
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  const address = remoteAddress?.split("%")[0]?.toLowerCase();
  return Boolean(
    address === "::1" ||
    address === "0:0:0:0:0:0:0:1" ||
    address?.startsWith("127.") ||
    address?.startsWith("::ffff:127.")
  );
}
