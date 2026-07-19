import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigProfileScope } from "../shared/types.js";
import { ConfigError, type ConfigStore } from "./config.js";
import {
  isRecord,
  readJsonBody,
  sendJson
} from "./http-utils.js";
import type { RequestLogger } from "./logger.js";
import { createStudioSnapshot, type StudioEventBroadcaster } from "./studio-events.js";
import type { DebugCaptureWriter } from "./debug-capture.js";
import type { CodexVersionMonitor } from "./codex-version.js";

export async function handleConfigApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  studioEvents: StudioEventBroadcaster,
  codexVersionMonitor: CodexVersionMonitor
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/config/profiles") {
    const publicConfig = configStore.toPublicConfig();
    const requestedScope = url.searchParams.get("scope");
    if (requestedScope === "codex" || requestedScope === "claude") {
      sendJson(res, 200, publicConfig.profile_scopes[requestedScope]);
      return true;
    }

    sendJson(res, 200, {
      profiles: publicConfig.profiles,
      active_profile_id: publicConfig.active_profile_id,
      profile_scopes: publicConfig.profile_scopes
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/config/export") {
    sendJson(res, 200, configStore.get());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/config/import") {
    const importedConfig = await readJsonBody(req);
    await configStore.importConfig(importedConfig);
    broadcastConfigSnapshot(configStore, logger, captureWriter, studioEvents, codexVersionMonitor, true);
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "PATCH" && url.pathname === "/api/config") {
    const patch = await readJsonBody(req);
    await configStore.patch(patch);
    broadcastConfigSnapshot(configStore, logger, captureWriter, studioEvents, codexVersionMonitor, true);
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/config/profiles") {
    const body = await readJsonBody(req);
    const record = requireRecordBody(body, "config profile save requires a name string.");
    if (typeof record.name !== "string") {
      throw new ConfigError("config profile save requires a name string.");
    }

    const profilePatch = Object.hasOwn(record, "config") ? record.config : {};
    await configStore.saveProfile(readProfileScope(record, url), record.name, profilePatch);
    broadcastConfigSnapshot(configStore, logger, captureWriter, studioEvents, codexVersionMonitor);
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "PATCH" && url.pathname === "/api/config/profiles") {
    const body = requireRecordBody(
      await readJsonBody(req),
      "config profile update requires a profile id."
    );
    const profilePatch = Object.hasOwn(body, "config") ? body.config : {};
    await configStore.updateProfile(
      readProfileScope(body, url),
      readProfileId(body, "update"),
      typeof body.name === "string" ? body.name : undefined,
      profilePatch
    );
    broadcastConfigSnapshot(configStore, logger, captureWriter, studioEvents, codexVersionMonitor);
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/config/profiles/reorder") {
    const body = requireRecordBody(
      await readJsonBody(req),
      "config profile reorder requires a profile id list."
    );
    const profileIds = Array.isArray(body.profile_ids) ? body.profile_ids : body.ordered_profile_ids;
    if (!Array.isArray(profileIds) || profileIds.some((profileId) => typeof profileId !== "string")) {
      throw new ConfigError("config profile reorder requires a profile id list.");
    }

    await configStore.reorderProfiles(readProfileScope(body, url), profileIds);
    broadcastConfigSnapshot(configStore, logger, captureWriter, studioEvents, codexVersionMonitor);
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/config/profiles/duplicate") {
    const body = requireRecordBody(
      await readJsonBody(req),
      "config profile duplicate requires a profile id."
    );
    await configStore.duplicateProfile(
      readProfileScope(body, url),
      readProfileId(body, "duplicate"),
      typeof body.name === "string" ? body.name : undefined
    );
    broadcastConfigSnapshot(configStore, logger, captureWriter, studioEvents, codexVersionMonitor);
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/config/profiles") {
    const body = requireRecordBody(
      await readJsonBody(req),
      "config profile delete requires a profile id."
    );
    await configStore.deleteProfile(readProfileScope(body, url), readProfileId(body, "delete"));
    broadcastConfigSnapshot(configStore, logger, captureWriter, studioEvents, codexVersionMonitor);
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/config/profiles/apply") {
    const body = requireRecordBody(
      await readJsonBody(req),
      "config profile apply requires a profile id."
    );
    await configStore.applyProfile(readProfileScope(body, url), readProfileId(body, "apply"));
    broadcastConfigSnapshot(configStore, logger, captureWriter, studioEvents, codexVersionMonitor, true);
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  return false;
}

function broadcastConfigSnapshot(
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  studioEvents: StudioEventBroadcaster,
  codexVersionMonitor: CodexVersionMonitor,
  syncLogging = false
): void {
  if (syncLogging) {
    const logging = configStore.get().logging;
    logger.configure({
      keepRecent: logging.keep_recent,
      maxDatabaseBytes: logging.max_database_bytes
    });
    captureWriter.configure(
      logging.capture_dir,
      logging.capture_body_max_bytes,
      logging.capture_dir_max_bytes
    );
  }
  studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger, codexVersionMonitor));
}

function requireRecordBody(body: unknown, message: string): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new ConfigError(message);
  }

  return body;
}

function readProfileId(body: Record<string, unknown>, operation: string): string {
  const profileId = typeof body.profile_id === "string" ? body.profile_id : body.id;
  if (typeof profileId !== "string") {
    throw new ConfigError(`config profile ${operation} requires a profile id.`);
  }

  return profileId;
}

function readProfileScope(body: Record<string, unknown>, url: URL): ConfigProfileScope {
  const value = typeof body.scope === "string" ? body.scope : url.searchParams.get("scope") ?? "codex";
  if (value !== "codex" && value !== "claude") {
    throw new ConfigError("config profile scope must be codex or claude.");
  }
  return value;
}
