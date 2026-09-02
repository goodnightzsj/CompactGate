import type { IncomingHttpHeaders } from "node:http";
import type { CompactGateConfig } from "../shared/types.js";
import type { TokenUsageMetrics } from "./usage-types.js";

export type PrimaryResultCategory =
  | "success"
  | "auth"
  | "quota"
  | "rate_limit"
  | "transient"
  | "model_incompatible"
  | "request_shape"
  | "client_cancel";

export interface PrimaryRouteRequestContext {
  endpoint?: string | null;
  model?: string | null;
  previousResponseId?: string | null;
  sessionKey?: string | null;
  compactionStateKey?: string | null;
}

export interface PrimaryRouteSelection {
  config: CompactGateConfig;
  /** The profile id, never the composite candidate id — `applyProfile` and the
   * provider-state binding table are profile-scoped. */
  profileId: string | null;
  /** The selected key within a pooled profile, null when the profile has no pool. */
  keyId: string | null;
  /** The selected key's label from the pool; null for the profile's own key. */
  keyLabel: string | null;
  /** Composite `profileId#keyId` that health and stickiness are keyed by. */
  candidateId: string | null;
  profileName: string | null;
  generation: number;
  healthVersion: number;
  context: Required<PrimaryRouteRequestContext>;
}

export interface PrimaryRouteResult {
  status: number;
  errorSummary: string | null;
  responseHeaders?: IncomingHttpHeaders;
  responseBody?: Buffer;
  firstTokenMs?: number | null;
  responseId?: string | null;
  usage?: TokenUsageMetrics;
}

export interface PrimaryCandidate {
  /** Composite `profileId#keyId` for pooled profiles, plain profile id otherwise. */
  id: string;
  profileId: string;
  keyId: string | null;
  keyLabel: string | null;
  name: string;
  config: CompactGateConfig;
  order: number;
  active: boolean;
  /** Account-bound credential: automatic rotation must skip it, manual use must not. */
  rotationOptOut: boolean;
}
