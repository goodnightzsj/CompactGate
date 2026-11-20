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
import type { LogStatsOptions } from "./logger-analytics.js";
import { LogStatsBusyError } from "./log-stats-reader.js";
import type { CaptureReadResult, DebugCaptureWriter } from "./debug-capture.js";
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
import type { ClientIdentityKind, LogDrilldownFilter } from "../shared/types.js";
import { DAY_MS, MAX_LOG_RANGE_DAYS } from "../shared/log-range.js";
import { resolveRequestScopedProfile } from "./request-profile.js";
import { probeCompactCapability } from "./compact-capability-probe.js";
import { ProtocolConversionError, UnsupportedClientProtocolError } from "./protocol-conversion.js";

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
      model: body.model,
      clientIdentity,
      oauth: configStore.oauth
    }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/test-route") {
    const body = await readJsonBody(req);

    if (!isRecord(body) || typeof body.path !== "string") {
      throw new ConfigError("test-route requires a path string.");
    }

    const method = typeof body.method === "string" ? body.method.toUpperCase() : "POST";
    const requestBody = method === "GET" ? undefined : body.body;
    try {
      const config = configStore.get();
      const parsedUrl = new URL(body.path, "http://compactgate.local");
      const previewHeaders = isRecord(body.headers)
        ? Object.fromEntries(
            Object.entries(body.headers)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string")
              .map(([name, value]) => [name.toLowerCase(), value])
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
        const classification = classifyOpenAiRequest(parsedUrl.pathname, requestBody, previewHeaders);
        const usesPrimaryPlan = classification.route === "primary" ||
          classification.compactionMode === "remote_v2" ||
          (classification.route === "compact" && config.compact.upstream_mode === "primary");
        if (usesPrimaryPlan && !requestProfile) {
          previewConfig = primaryFailover.preview(
            config,
            primaryRouteRequestContextFromBody(
              Buffer.from(typeof requestBody === "string" ? requestBody : JSON.stringify(requestBody ?? {})),
              previewHeaders,
              parsedUrl.pathname,
              classification.route === "compact" && classification.compactionMode !== "remote_v2" ? "compact" : "primary"
            )
          ).config;
        }
      }
      sendJson(res, 200, {
        ...previewRoute(method, body.path, requestBody, previewConfig, previewHeaders),
        ...(requestProfile
          ? {
              profile_id: requestProfile.profileId,
              profile_source: requestProfile.source
            }
          : {})
      });
    } catch (error) {
      if (error instanceof ProtocolConversionError) {
        sendJson(res, error.status, { error: error instanceof UnsupportedClientProtocolError
          ? { type: "invalid_request_error", code: "unsupported_protocol", message: error.message } : error.message });
        return true;
      }
      if (error instanceof TypeError) {
        throw new ConfigError("test-route path must be a valid URL or path.");
      }

      throw error;
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, healthForConfig(configStore.get(), logger, codexVersionMonitor, clientIdentity, configStore.oauth));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/claude/models") {
    sendJson(res, 200, await fetchClaudeModels(configStore.get(), clientIdentity, configStore.oauth));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/openai/models") {
    sendJson(res, 200, await fetchOpenAiModels(configStore.get(), clientIdentity, configStore.oauth));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/logs/recent") {
    const options = readLogPageQuery(url, configStore);
    await sendLogReadResponse(req, res, signal => logger.pageAsync(options, signal));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/logs/stats") {
    const options = readLogStatsQuery(url);
    await sendLogReadResponse(req, res, signal => logger.statsAsync(options, signal));
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

    const result = await logger.purgeStoredBodies();
    sendJson(res, 200, result);
    return true;
  }

  const captureMatch = url.pathname.match(
    /^\/api\/logs\/([^/]+)\/capture(?:\/(download))?$/
  );
  if (req.method === "GET" && captureMatch) {
    await withLogReadSignal(req, res, signal => sendCaptureResponse(
      res,
      captureMatch[1],
      captureMatch[2] === "download",
      logger,
      captureWriter,
      studioEvents,
      signal
    ));
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

async function sendLogReadResponse(
  req: IncomingMessage,
  res: ServerResponse,
  read: (signal: AbortSignal) => Promise<unknown>
): Promise<void> {
  await withLogReadSignal(req, res, async signal => {
    const data = await read(signal);
    if (!res.destroyed) sendJson(res, 200, data);
  });
}

async function withLogReadSignal(
  req: IncomingMessage,
  res: ServerResponse,
  send: (signal: AbortSignal) => Promise<void>
): Promise<void> {
  if (req.aborted || res.destroyed) return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  try {
    await send(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return;
    if (!(error instanceof LogStatsBusyError)) throw error;
    res.setHeader("retry-after", "1");
    sendJson(res, 503, { error: error.message });
  } finally {
    req.off("aborted", abort);
    res.off("close", abort);
  }
}

async function sendCaptureResponse(
  res: ServerResponse,
  requestId: string,
  download: boolean,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  studioEvents: StudioEventBroadcaster,
  signal: AbortSignal
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

  let capture: CaptureReadResult;
  try {
    if (!lookup.capturePath) throw new Error("Registered capture has no path.");
    capture = await captureWriter.readCapture(lookup.capturePath, requestId, !download, signal);
    if (signal.aborted) return;
    if (capture.status === "unavailable") {
      throw new Error("Registered capture is not a managed regular file with the matching request ID.");
    }
  } catch (error) {
    if (signal.aborted) return;
    console.error(`Capture read failed for request ${requestId}:`, error);
    sendJson(res, 500, {
      error: "Capture could not be read.",
      request_id: requestId,
      capture_status: lookup.captureStatus
    });
    return;
  }
  if (capture.status === "missing") {
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
  let drilldown: LogDrilldownFilter | undefined;
  if (["from", "to", "model", "calendar_tz"].some((key) => url.searchParams.has(key))) {
    if (!url.searchParams.get("from") || !url.searchParams.get("to")) {
      throw new ConfigError("Log drilldown requires both from and to.");
    }
    const { from, to } = readLogStatsRange(url);
    drilldown = { from, to };
    if (url.searchParams.has("model")) {
      const model = url.searchParams.get("model")!;
      if (model.length > 8192) throw new ConfigError("Log model filter is too long.");
      drilldown.model = model === "" ? null : model;
    }
  }
  const keepRecent = configStore.get().logging.keep_recent;
  const requestedLimit = parsePositiveInteger(url.searchParams.get("limit"), keepRecent);
  const limit = Math.min(requestedLimit, keepRecent);
  const offset = parseNonNegativeInteger(url.searchParams.get("offset"), 0);
  return { route, status, host, search, drilldown, limit, offset };
}

function readLogStatsRange(url: URL): Pick<LogStatsOptions, "from" | "to" | "calendar_tz"> {
  const toTime = parseStatsTimestamp(url.searchParams.get("to"), Date.now(), "to");
  const fromTime = parseStatsTimestamp(
    url.searchParams.get("from"),
    toTime - DAY_MS,
    "from"
  );

  if (fromTime >= toTime) {
    throw new ConfigError("logs stats requires from to be earlier than to.");
  }
  const timeZone = url.searchParams.get("calendar_tz");
  const range = { from: new Date(fromTime).toISOString(), to: new Date(toTime).toISOString() };
  if (timeZone !== null) {
    if (/^[+-]/.test(timeZone)) throw new ConfigError("logs stats calendar_tz must be a named time zone.");
    let format: Intl.DateTimeFormat;
    try {
      format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", era: "short" });
    } catch (error) {
      if (error instanceof RangeError) throw new ConfigError("logs stats calendar_tz must be a valid time zone.");
      throw error;
    }
    // The exclusive end may be midnight on the next date. Count only dates included in [from, to).
    if (calendarDay(toTime - 1, format) - calendarDay(fromTime, format) >= MAX_LOG_RANGE_DAYS) {
      throw new ConfigError(`logs stats range cannot exceed ${MAX_LOG_RANGE_DAYS} calendar days.`);
    }
    return { ...range, calendar_tz: timeZone };
  }
  if (toTime - fromTime > MAX_LOG_RANGE_DAYS * DAY_MS) {
    throw new ConfigError("logs stats range cannot exceed 31 days.");
  }
  return range;
}

function calendarDay(time: number, format: Intl.DateTimeFormat): number {
  const parts = Object.fromEntries(format.formatToParts(time).map(({ type, value }) => [type, value]));
  const year = Number(parts.year);
  const utc = new Date(0);
  utc.setUTCFullYear(parts.era === "BC" ? 1 - year : year, Number(parts.month) - 1, Number(parts.day));
  return utc.getTime() / DAY_MS;
}

function readLogStatsQuery(url: URL): LogStatsOptions {
  const range = readLogStatsRange(url);
  const view = url.searchParams.get("view");
  if (view !== null && view !== "usage") {
    throw new ConfigError("logs stats view must be usage when supplied.");
  }
  if (view === "usage" && url.searchParams.get("overview") === "1") {
    throw new ConfigError("logs stats overview is unavailable for the usage view.");
  }

  return {
    ...range,
    includeOverview: url.searchParams.get("overview") === "1",
    ...(view === "usage" ? { view } : {})
  };
}

function parseStatsTimestamp(value: string | null, fallback: number, name: string): number {
  if (value === null || value.length === 0) {
    return fallback;
  }

  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts) {
    throw new ConfigError(`logs stats ${name} must be an RFC 3339 timestamp.`);
  }
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts.slice(1).map(part => Number(part ?? 0));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const timestamp = Date.parse(value);
  if (day < 1 || day > (days[month - 1] ?? 0) || hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59 || !Number.isFinite(timestamp)) {
    throw new ConfigError(`logs stats ${name} must be an RFC 3339 timestamp.`);
  }
  return timestamp;
}
