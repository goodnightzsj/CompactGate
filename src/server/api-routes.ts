import type { IncomingMessage, ServerResponse } from "node:http";
import type { CompactGateConfig, ConfigProfileScope } from "../shared/types.js";
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

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  studioEvents: StudioEventBroadcaster,
  fetchClaudeModels: FetchClaudeModels
): Promise<void> {
  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config/profiles") {
    const publicConfig = configStore.toPublicConfig();
    const requestedScope = url.searchParams.get("scope");
    if (requestedScope === "codex" || requestedScope === "claude") {
      sendJson(res, 200, publicConfig.profile_scopes[requestedScope]);
      return;
    }

    sendJson(res, 200, {
      profiles: publicConfig.profiles,
      active_profile_id: publicConfig.active_profile_id,
      profile_scopes: publicConfig.profile_scopes
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config/export") {
    sendJson(res, 200, configStore.get());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/import") {
    const importedConfig = await readJsonBody(req);
    await configStore.importConfig(importedConfig);
    logger.resize(configStore.get().logging.keep_recent);
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/config") {
    const patch = await readJsonBody(req);
    await configStore.patch(patch);
    logger.resize(configStore.get().logging.keep_recent);
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/profiles") {
    const body = await readJsonBody(req);
    if (!isRecord(body) || typeof body.name !== "string") {
      throw new ConfigError("config profile save requires a name string.");
    }

    const profilePatch = Object.hasOwn(body, "config") ? body.config : {};
    await configStore.saveProfile(readProfileScope(body, url), body.name, profilePatch);
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/config/profiles") {
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      throw new ConfigError("config profile update requires a profile id.");
    }

    const profileId = typeof body.profile_id === "string" ? body.profile_id : body.id;
    if (typeof profileId !== "string") {
      throw new ConfigError("config profile update requires a profile id.");
    }

    const profilePatch = Object.hasOwn(body, "config") ? body.config : {};
    await configStore.updateProfile(
      readProfileScope(body, url),
      profileId,
      typeof body.name === "string" ? body.name : undefined,
      profilePatch
    );
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/profiles/reorder") {
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      throw new ConfigError("config profile reorder requires a profile id list.");
    }

    const profileIds = Array.isArray(body.profile_ids) ? body.profile_ids : body.ordered_profile_ids;
    if (!Array.isArray(profileIds) || profileIds.some((profileId) => typeof profileId !== "string")) {
      throw new ConfigError("config profile reorder requires a profile id list.");
    }

    await configStore.reorderProfiles(readProfileScope(body, url), profileIds);
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/profiles/duplicate") {
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      throw new ConfigError("config profile duplicate requires a profile id.");
    }

    const profileId = typeof body.profile_id === "string" ? body.profile_id : body.id;
    if (typeof profileId !== "string") {
      throw new ConfigError("config profile duplicate requires a profile id.");
    }

    await configStore.duplicateProfile(
      readProfileScope(body, url),
      profileId,
      typeof body.name === "string" ? body.name : undefined
    );
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/config/profiles") {
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      throw new ConfigError("config profile delete requires a profile id.");
    }

    const profileId = typeof body.profile_id === "string" ? body.profile_id : body.id;
    if (typeof profileId !== "string") {
      throw new ConfigError("config profile delete requires a profile id.");
    }

    await configStore.deleteProfile(readProfileScope(body, url), profileId);
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/profiles/apply") {
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      throw new ConfigError("config profile apply requires a profile id.");
    }

    const profileId = typeof body.profile_id === "string" ? body.profile_id : body.id;
    if (typeof profileId !== "string") {
      throw new ConfigError("config profile apply requires a profile id.");
    }

    await configStore.applyProfile(readProfileScope(body, url), profileId);
    logger.resize(configStore.get().logging.keep_recent);
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/test-route") {
    const body = await readJsonBody(req);

    if (!isRecord(body) || typeof body.path !== "string") {
      throw new ConfigError("test-route requires a path string.");
    }

    const method = typeof body.method === "string" ? body.method.toUpperCase() : "POST";
    sendJson(
      res,
      200,
      previewRoute(method, body.path, body.body, configStore.get())
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, healthForConfig(configStore.get()));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/claude/models") {
    sendJson(res, 200, await fetchClaudeModels(configStore.get()));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/logs/recent") {
    const route = parseRouteFilter(url.searchParams.get("route"));
    const status = parseStatusFilter(url.searchParams.get("status"));
    const host = parseHostFilter(url.searchParams.get("host"));
    const limit = parsePositiveInteger(url.searchParams.get("limit"), configStore.get().logging.keep_recent);
    const offset = parseNonNegativeInteger(url.searchParams.get("offset"), 0);
    sendJson(res, 200, logger.page({ route, status, host, limit, offset }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    studioEvents.subscribe(req, res, createStudioSnapshot(configStore, logger));
    return;
  }

  sendJson(res, 404, { error: "API endpoint not found." });
}

function readProfileScope(body: Record<string, unknown>, url: URL): ConfigProfileScope {
  const value = typeof body.scope === "string" ? body.scope : url.searchParams.get("scope") ?? "codex";
  if (value !== "codex" && value !== "claude") {
    throw new ConfigError("config profile scope must be codex or claude.");
  }
  return value;
}
