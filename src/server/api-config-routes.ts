import type { IncomingMessage, ServerResponse } from "node:http";
import type { CompactGateConfig, ConfigProfileScope } from "../shared/types.js";
import { ConfigError, type ConfigStore } from "./config.js";
import { FileCommitError } from "./config-file-repository.js";
import {
  isRecord,
  readJsonBody,
  sendJson
} from "./http-utils.js";
import type { RequestLogger } from "./logger.js";
import { createStudioSnapshot, type StudioEventBroadcaster } from "./studio-events.js";
import type { DebugCaptureWriter } from "./debug-capture.js";
import type { CodexVersionMonitor } from "./codex-version.js";
import type { ClientIdentityStore } from "./client-identity-store.js";
import type { PrimaryFailoverState } from "./primary-failover.js";
import { handleOAuthApi } from "./api-oauth-routes.js";

export async function handleConfigApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  studioEvents: StudioEventBroadcaster,
  codexVersionMonitor: CodexVersionMonitor,
  primaryFailover: PrimaryFailoverState,
  clientIdentity: ClientIdentityStore
): Promise<boolean> {
  try {
    if (await handleOAuthApi(req, res, url, configStore, () =>
      broadcastConfigSnapshot(configStore, logger, captureWriter, studioEvents, codexVersionMonitor, clientIdentity)
    )) return true;
  } catch (error) {
    if (error instanceof FileCommitError) {
      broadcastConfigSnapshot(configStore, logger, captureWriter, studioEvents, codexVersionMonitor, clientIdentity);
    }
    throw error;
  }

  async function commit(
    write: () => Promise<CompactGateConfig>,
    syncLogging = false,
    afterCommit?: (config: CompactGateConfig) => void
  ): Promise<void> {
    let next: CompactGateConfig;
    let commitError: FileCommitError | undefined;
    try {
      next = await write();
    } catch (error) {
      if (!(error instanceof FileCommitError) || error.filePath !== configStore.getConfigPath()) throw error;
      next = configStore.get();
      commitError = error;
    }
    // Post-rename failure must not leave runtime consumers on the old config.
    afterCommit?.(next);
    broadcastConfigSnapshot(configStore, logger, captureWriter, studioEvents, codexVersionMonitor, clientIdentity, syncLogging);
    if (commitError) throw commitError;
  }

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
    sendJson(res, 200, configStore.get(url.searchParams.get("revision")));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/config/backups") {
    sendJson(res, 200, { backups: await configStore.listBackups() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/config/backups/restore") {
    const body = requireBackupConfirmation(await readJsonBody(req), "restore");
    await commit(() => configStore.restoreBackup(body.backup_id), true);
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/config/backups") {
    const body = requireBackupConfirmation(await readJsonBody(req), "delete");
    await configStore.deleteBackup(body.backup_id);
    sendJson(res, 200, { deleted: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/config/import") {
    const importedConfig = await readJsonBody(req);
    await commit(() => configStore.importConfig(importedConfig), true);
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "PATCH" && url.pathname === "/api/config") {
    const patch = await readJsonBody(req);
    await commit(() => configStore.patch(patch), true);
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/config/profiles") {
    const body = await readJsonBody(req);
    const record = requireRecordBody(body, "config profile save requires a name string.");
    if (typeof record.name !== "string") {
      throw new ConfigError("config profile save requires a name string.");
    }
    const name = record.name;

    const profilePatch = Object.hasOwn(record, "config") ? record.config : {};
    await commit(() => configStore.saveProfile(
      readProfileScope(record, url),
      name,
      profilePatch,
      record.revision
    ));
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "PATCH" && url.pathname === "/api/config/profiles") {
    const body = requireRecordBody(
      await readJsonBody(req),
      "config profile update requires a profile id."
    );
    const profilePatch = Object.hasOwn(body, "config") ? body.config : undefined;
    await commit(() => configStore.updateProfile(
      readProfileScope(body, url),
      readProfileId(body, "update"),
      typeof body.name === "string" ? body.name : undefined,
      profilePatch,
      body.revision
    ));
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

    await commit(() => configStore.reorderProfiles(readProfileScope(body, url), profileIds));
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/config/profiles/duplicate") {
    const body = requireRecordBody(
      await readJsonBody(req),
      "config profile duplicate requires a profile id."
    );
    await commit(() => configStore.duplicateProfile(
      readProfileScope(body, url),
      readProfileId(body, "duplicate"),
      typeof body.name === "string" ? body.name : undefined,
      readOptionalProfileScope(body.target_scope)
    ));
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/config/profiles") {
    const body = requireRecordBody(
      await readJsonBody(req),
      "config profile delete requires a profile id."
    );
    await commit(() => configStore.deleteProfile(readProfileScope(body, url), readProfileId(body, "delete")));
    sendJson(res, 200, configStore.toPublicConfig());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/config/profiles/apply") {
    const body = requireRecordBody(
      await readJsonBody(req),
      "config profile apply requires a profile id."
    );
    const scope = readProfileScope(body, url);
    const profileId = readProfileId(body, "apply");
    await commit(() => configStore.applyProfile(scope, profileId), true, (applied) => {
      if (scope === "codex") primaryFailover.forceNextProfileSelection(applied, profileId);
    });
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
  clientIdentity: ClientIdentityStore,
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
  studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger, codexVersionMonitor, clientIdentity));
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

function readOptionalProfileScope(value: unknown): ConfigProfileScope | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value !== "codex" && value !== "claude") {
    throw new ConfigError("config profile target_scope must be codex or claude.");
  }
  return value;
}

function requireBackupConfirmation(
  body: unknown,
  operation: "restore" | "delete"
): { backup_id: string } {
  if (
    !isRecord(body) ||
    typeof body.backup_id !== "string" ||
    body.backup_id.length === 0 ||
    body.confirm !== true
  ) {
    throw new ConfigError(`config backup ${operation} requires backup_id and confirm=true.`);
  }

  return { backup_id: body.backup_id };
}
