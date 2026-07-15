import type { IncomingMessage, ServerResponse } from "node:http";
import type { CompactGateConfig } from "../shared/types.js";
import { ConfigError, type ConfigStore } from "./config.js";
import { healthForConfig } from "./health.js";
import {
  isRecord,
  parseHostFilter,
  parseNonNegativeInteger,
  parsePositiveInteger,
  parseRouteFilter,
  parseStatusFilter,
  readJsonBody,
  sendJson
} from "./http-utils.js";
import type { RequestLogger } from "./logger.js";
import { previewRoute } from "./routing.js";
import { createStudioSnapshot, type StudioEventBroadcaster } from "./studio-events.js";

export type FetchClaudeModels = (config: CompactGateConfig) => Promise<{
  models: string[];
  upstream_host: string;
  error: string | null;
}>;

export async function handleRuntimeApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  studioEvents: StudioEventBroadcaster,
  fetchClaudeModels: FetchClaudeModels
): Promise<boolean> {
  if (req.method === "POST" && url.pathname === "/api/test-route") {
    const body = await readJsonBody(req);

    if (!isRecord(body) || typeof body.path !== "string") {
      throw new ConfigError("test-route requires a path string.");
    }

    const method = typeof body.method === "string" ? body.method.toUpperCase() : "POST";
    try {
      sendJson(res, 200, previewRoute(method, body.path, body.body, configStore.get()));
    } catch (error) {
      if (error instanceof TypeError) {
        throw new ConfigError("test-route path must be a valid URL or path.");
      }

      throw error;
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, healthForConfig(configStore.get(), logger));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/claude/models") {
    sendJson(res, 200, await fetchClaudeModels(configStore.get()));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/logs/recent") {
    sendJson(res, 200, logger.page(readLogPageQuery(url, configStore)));
    return true;
  }

  const logByIdMatch = url.pathname.match(/^\/api\/logs\/([^/]+)$/);
  if (req.method === "GET" && logByIdMatch) {
    const requestId = logByIdMatch[1];
    const result = logger.getByRequestId(requestId);
    if (result.status === "not_found") {
      sendJson(res, 404, {
        error: "Request ID not found",
        request_id: requestId
      });
      return true;
    }
    if (result.status === "multiple") {
      sendJson(res, 409, {
        error: "Request ID not unique",
        request_id: requestId
      });
      return true;
    }
    sendJson(res, 200, result.entry);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    studioEvents.subscribe(req, res, createStudioSnapshot(configStore, logger));
    return true;
  }

  return false;
}

function readLogPageQuery(url: URL, configStore: ConfigStore) {
  const route = parseRouteFilter(url.searchParams.get("route"));
  const status = parseStatusFilter(url.searchParams.get("status"));
  const host = parseHostFilter(url.searchParams.get("host"));
  const keepRecent = configStore.get().logging.keep_recent;
  const requestedLimit = parsePositiveInteger(url.searchParams.get("limit"), keepRecent);
  const limit = Math.min(requestedLimit, keepRecent);
  const offset = parseNonNegativeInteger(url.searchParams.get("offset"), 0);
  return { route, status, host, limit, offset };
}
