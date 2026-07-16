import type { IncomingMessage, ServerResponse } from "node:http";
import type { FetchClaudeModels } from "./claude-models.js";
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
import type { DebugCaptureWriter } from "./debug-capture.js";
import type { FetchOpenAiModels } from "./openai-models.js";
import {
  PrimaryFailoverState,
  primaryRouteRequestContextFromBody
} from "./primary-failover.js";
import { previewRoute, routeForPath } from "./routing.js";
import { createStudioSnapshot, type StudioEventBroadcaster } from "./studio-events.js";

export async function handleRuntimeApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  studioEvents: StudioEventBroadcaster,
  fetchClaudeModels: FetchClaudeModels,
  fetchOpenAiModels: FetchOpenAiModels,
  primaryFailover: PrimaryFailoverState
): Promise<boolean> {
  if (req.method === "POST" && url.pathname === "/api/test-route") {
    const body = await readJsonBody(req);

    if (!isRecord(body) || typeof body.path !== "string") {
      throw new ConfigError("test-route requires a path string.");
    }

    const method = typeof body.method === "string" ? body.method.toUpperCase() : "POST";
    try {
      const config = configStore.get();
      const parsedUrl = new URL(body.path, "http://compactgate.local");
      const previewConfig = routeForPath(parsedUrl.pathname, body.body) === "primary"
        ? primaryFailover.preview(
            config,
            primaryRouteRequestContextFromBody(
              Buffer.from(typeof body.body === "string" ? body.body : JSON.stringify(body.body ?? {})),
              req.headers,
              parsedUrl.pathname
            )
          ).config
        : config;
      sendJson(res, 200, previewRoute(method, body.path, body.body, previewConfig));
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

  if (req.method === "GET" && url.pathname === "/api/openai/models") {
    sendJson(res, 200, await fetchOpenAiModels(configStore.get()));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/logs/recent") {
    sendJson(res, 200, logger.page(readLogPageQuery(url, configStore)));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/logs/maintenance/purge-bodies") {
    const body = await readJsonBody(req);
    if (!isRecord(body) || body.confirm !== true) {
      sendJson(res, 400, {
        error: "Body purge requires confirm: true."
      });
      return true;
    }

    const result = logger.purgeStoredBodies();
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, result);
    return true;
  }

  const captureMatch = url.pathname.match(
    /^\/api\/logs\/([^/]+)\/capture(?:\/(download))?$/
  );
  if (req.method === "GET" && captureMatch) {
    await sendCaptureResponse(
      res,
      captureMatch[1],
      captureMatch[2] === "download",
      logger,
      captureWriter,
      studioEvents
    );
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

async function sendCaptureResponse(
  res: ServerResponse,
  requestId: string,
  download: boolean,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  studioEvents: StudioEventBroadcaster
): Promise<void> {
  const lookup = logger.getCaptureByRequestId(requestId);
  if (lookup.status === "not_found") {
    sendJson(res, 404, {
      error: "Request ID not found",
      request_id: requestId
    });
    return;
  }
  if (lookup.status === "multiple") {
    sendJson(res, 409, {
      error: "Request ID not unique",
      request_id: requestId
    });
    return;
  }
  if (lookup.captureStatus === "pending") {
    sendJson(res, 202, {
      request_id: requestId,
      capture_status: "pending"
    });
    return;
  }
  if (lookup.captureStatus === "none") {
    sendJson(res, 404, {
      error: "Capture not available",
      request_id: requestId,
      capture_status: "none"
    });
    return;
  }
  if (lookup.captureStatus === "purged") {
    sendJson(res, 410, {
      error: "Capture has been purged",
      request_id: requestId,
      capture_status: "purged"
    });
    return;
  }

  const capture = lookup.capturePath
    ? await captureWriter.readCapture(lookup.capturePath, requestId)
    : { status: "unavailable" as const };
  if (capture.status === "unavailable") {
    const updatedEntry = logger.markCapturePurgedByRequestId(requestId);
    if (updatedEntry) {
      studioEvents.broadcastLog(updatedEntry, "update");
    }
    sendJson(res, 410, {
      error: "Capture is no longer available",
      request_id: requestId,
      capture_status: "purged"
    });
    return;
  }

  res.setHeader("cache-control", "no-store");
  if (!download) {
    sendJson(res, 200, capture.record);
    return;
  }

  const safeRequestId = requestId.replace(/[^a-z0-9-]/gi, "") || "capture";
  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader(
    "content-disposition",
    `attachment; filename="compactgate-capture-${safeRequestId}.json"`
  );
  res.setHeader("content-length", String(capture.content.byteLength));
  res.end(capture.content);
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
