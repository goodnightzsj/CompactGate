import type { ProviderFamily, RouteKind } from "./types.js";

export interface RouteMeta {
  route: RouteKind;
  provider: ProviderFamily;
  label: string;
  summary: string;
}

export const ROUTE_META: Record<RouteKind, RouteMeta> = {
  primary: {
    route: "primary",
    provider: "openai",
    label: "普通",
    summary: "OpenAI/Codex 主上游"
  },
  compact: {
    route: "compact",
    provider: "openai",
    label: "压缩",
    summary: "OpenAI/Codex Compact"
  },
  claude: {
    route: "claude",
    provider: "claude",
    label: "Claude",
    summary: "Anthropic Claude"
  }
};

export const PROVIDER_LABELS: Record<ProviderFamily, string> = {
  openai: "Codex/OpenAI",
  claude: "Claude"
};

export function routeLabel(route: RouteKind): string {
  return ROUTE_META[route].label;
}

export function routeProvider(route: RouteKind): ProviderFamily {
  return ROUTE_META[route].provider;
}
