import type { IncomingHttpHeaders } from "node:http";
import type { CompactGateConfig } from "../shared/types.js";

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
  profileId: string | null;
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
}

export interface PrimaryProfileHealthSnapshot {
  profileId: string;
  inFlight: number;
  transientFailures: number;
  emptyStreamFailures: number;
  cooldownUntil: number;
  quarantineUntil: number;
  rateLimitUntil: number;
  modelCooldowns: Array<{ model: string; until: number; reason: string }>;
}

export interface PrimaryCandidate {
  id: string;
  name: string;
  config: CompactGateConfig;
  order: number;
  active: boolean;
}
