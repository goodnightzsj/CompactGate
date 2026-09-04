import type { IncomingMessage, ServerResponse } from "node:http";
import { fetchClaudeModels } from "./claude-models.js";
import { ConfigError, type ConfigStore } from "./config.js";
import { healthForConfig } from "./health.js";
import {
  isRecord,
  parseHostFilter,
  parseNonNegativeInteger,
  parsePositiveInteger,
  parseRouteFilter,
  parseSearchFilter,
  parseStatusFilter,
  readJsonBody,
  sendJson
} from "./http-utils.js";
import type { RequestLogger } from "./logger.js";
import type { DebugCaptureWriter } from "./debug-capture.js";
import { fetchOpenAiModels } from "./openai-models.js";
import {
  PrimaryFailoverState,
  primaryRouteRequestContextFromBody
} from "./primary-failover.js";
import {
  classifyOpenAiRequest,
  isClaudeIngressPath,
  previewRoute
} from "./routing.js";
import { createStudioSnapshot, type StudioEventBroadcaster } from "./studio-events.js";
import type { CodexVersionMonitor } from "./codex-version.js";
import {
  ClientIdentityValueError,
  type ClientIdentityKindPatch,
  type ClientIdentityPatch,
  type ClientIdentityStore
} from "./client-identity-store.js";
import type { ClientIdentityKind } from "../shared/types.js";
import { resolveRequestScopedProfile } from "./request-profile.js";
import { probeCompactCapability } from "./compact-capability-probe.js";

export async function handleRuntimeApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  studioEvents: StudioEventBroadcaster,
  primaryFailover: PrimaryFailoverState,
  codexVersionMonitor: CodexVersionMonitor,
  clientIdentity: ClientIdentityStore
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/api/client-identity") {
    sendJson(res, 200, clientIdentity.status());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/client-identity") {
    const body = requireRecord(await readJsonBody(req), "client-identity body must be a JSON object.");
    try {
      const status = body.refresh === true
        ? await clientIdentity.refreshNow(readIdentityKind(body.kind))
        : await clientIdentity.update(readClientIdentityPatch(body));
      studioEvents.broadcastSnapshot(
        createStudioSnapshot(configStore, logger, codexVersionMonitor, clientIdentity)
      );
      sendJson(res, 200, status);
    } catch (error) {
      if (error instanceof ClientIdentityValueError) {
        throw new ConfigError(error.message);
      }
      throw error;
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/compact/capability-probe") {
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      throw new ConfigError("compact capability probe body must be a JSON object.");
    }
    const baseConfig = configStore.get();
    const requestProfile = resolveRequestScopedProfile(
      baseConfig,
      "codex",
      req.headers,
      req.socket.remoteAddress
    );
    sendJson(res, 200, await probeCompactCapability({
      req,
      res,
      config: requestProfile?.config ?? baseConfig,
      model: body.model
    }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/test-route") {
    const body = await readJsonBody(req);

    if (!isRecord(body) || typeof body.path !== "string") {
      throw new ConfigError("test-route requires a path string.");
    }

    const method = typeof body.method === "string" ? body.method.toUpperCase() : "POST";
    try {
      const config = configStore.get();
      const parsedUrl = new URL(body.path, "http://compactgate.local");
      const previewHeaders = isRecord(body.headers)
        ? Object.fromEntries(
            Object.entries(body.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")
          )
        : undefined;
      const requestProfile = resolveRequestScopedProfile(
        config,
        isClaudeIngressPath(parsedUrl.pathname) ? "claude" : "codex",
        previewHeaders ?? {},
        req.socket.remoteAddress
      );
      let previewConfig = requestProfile?.config ?? config;
      if (!isClaudeIngressPath(parsedUrl.pathname)) {
        const classification = classifyOpenAiRequest(parsedUrl.pathname, body.body, previewHeaders);
        const usesPrimaryPlan = classification.route === "primary" ||
          classification.compactionMode === "remote_v2" ||
          (classification.route === "compact" && config.compact.upstream_mode === "primary");
        if (usesPrimaryPlan && !requestProfile) {
          previewConfig = primaryFailover.preview(
            config,
            primaryRouteRequestContextFromBody(
              Buffer.from(typeof body.body === "string" ? body.body : JSON.stringify(body.body ?? {})),
              previewHeaders,
              parsedUrl.pathname
            )
          ).config;
        }
      }
      sendJson(res, 200, {
        ...previewRoute(method, body.path, body.body, previewConfig, previewHeaders),
        ...(requestProfile
          ? {
              profile_id: requestProfile.profileId,
              profile_source: requestProfile.source
            }
          : {})
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new ConfigError("test-route path must be a valid URL or path.");
      }

      throw error;
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, healthForConfig(configStore.get(), logger, codexVersionMonitor, clientIdentity));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/claude/models") {
    sendJson(res, 200, await fetchClaudeModels(configStore.get(), clientIdentity));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/openai/models") {
    sendJson(res, 200, await fetchOpenAiModels(configStore.get(), clientIdentity));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/logs/recent") {
    sendJson(res, 200, logger.page(readLogPageQuery(url, configStore)));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/logs/stats") {
    sendJson(res, 200, logger.stats(readLogStatsQuery(url)));
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
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger, codexVersionMonitor, clientIdentity));
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
    studioEvents.subscribe(req, res, createStudioSnapshot(configStore, logger, codexVersionMonitor, clientIdentity));
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

function requireRecord(body: unknown, message: string): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new ConfigError(message);
  }

  return body;
}

function readIdentityKind(value: unknown): ClientIdentityKind | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "codex" || value === "claude") {
    return value;
  }

  throw new ConfigError("client-identity kind must be codex or claude.");
}

function readClientIdentityPatch(body: Record<string, unknown>): ClientIdentityPatch {
  const patch: ClientIdentityPatch = {};
  if (Object.hasOwn(body, "enabled")) {
    if (typeof body.enabled !== "boolean") {
      throw new ConfigError("client-identity enabled must be a boolean.");
    }
    patch.enabled = body.enabled;
  }

  for (const kind of ["codex", "claude"] as const) {
    if (!Object.hasOwn(body, kind)) {
      continue;
    }
    patch[kind] = readClientIdentityKindPatch(
      requireRecord(body[kind], `client-identity ${kind} must be a JSON object.`),
      kind
    );
  }

  return patch;
}

function readClientIdentityKindPatch(
  body: Record<string, unknown>,
  kind: ClientIdentityKind
): ClientIdentityKindPatch {
  const patch: ClientIdentityKindPatch = {};
  if (Object.hasOwn(body, "preferred")) {
    if (body.preferred !== "extracted" && body.preferred !== "version_tracked") {
      throw new ConfigError(
        `client-identity ${kind} preferred must be extracted or version_tracked.`
      );
    }
    patch.preferred = body.preferred;
  }

  // `null` is meaningful here — it clears the manual flag and resumes automatic
  // updates — so presence is what decides, never truthiness.
  for (const field of ["extracted_user_agent", "version_tracked_user_agent"] as const) {
    if (!Object.hasOwn(body, field)) {
      continue;
    }
    const value = body[field];
    if (value !== null && typeof value !== "string") {
      throw new ConfigError(`client-identity ${kind} ${field} must be a string or null.`);
    }
    patch[field] = value;
  }

  return patch;
}

function readLogPageQuery(url: URL, configStore: ConfigStore) {
  const route = parseRouteFilter(url.searchParams.get("route"));
  const status = parseStatusFilter(url.searchParams.get("status"));
  const host = parseHostFilter(url.searchParams.get("host"));
  const search = parseSearchFilter(url.searchParams.get("search"));
  const keepRecent = configStore.get().logging.keep_recent;
  const requestedLimit = parsePositiveInteger(url.searchParams.get("limit"), keepRecent);
  const limit = Math.min(requestedLimit, keepRecent);
  const offset = parseNonNegativeInteger(url.searchParams.get("offset"), 0);
  return { route, status, host, search, limit, offset };
}

const MAX_LOG_STATS_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

function readLogStatsQuery(url: URL): { from: string; to: string; includeOverview: boolean } {
  const toTime = parseStatsTimestamp(url.searchParams.get("to"), Date.now(), "to");
  const fromTime = parseStatsTimestamp(
    url.searchParams.get("from"),
    toTime - 24 * 60 * 60 * 1000,
    "from"
  );

  if (fromTime >= toTime) {
    throw new ConfigError("logs stats requires from to be earlier than to.");
  }
  if (toTime - fromTime > MAX_LOG_STATS_RANGE_MS) {
    throw new ConfigError("logs stats range cannot exceed 31 days.");
  }

  return {
    from: new Date(fromTime).toISOString(),
    to: new Date(toTime).toISOString(),
    includeOverview: url.searchParams.get("overview") === "1"
  };
}

function parseStatsTimestamp(value: string | null, fallback: number, name: string): number {
  if (value === null || value.length === 0) {
    return fallback;
  }

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ConfigError(`logs stats ${name} must be an RFC 3339 timestamp.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new ConfigError(`logs stats ${name} must be an RFC 3339 timestamp.`);
  }
  return timestamp;
}
