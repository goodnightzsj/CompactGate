import type { HealthResponse } from "../shared/types.js";

export type ThemeMode = "auto" | "light" | "dark";

export type StudioPage = "dashboard" | "routes" | "config" | "logs" | "health";

export type PageMode = StudioPage;

export type HealthTone = "good" | "warn" | "bad";

export type HealthBadge = {
  label: string;
  tone: HealthTone;
};

export type HealthRouteCredentialConfig =
  | HealthResponse["primary"]
  | HealthResponse["compact"]
  | HealthResponse["claude"]["primary"]
  | HealthResponse["claude"]["compact"];
