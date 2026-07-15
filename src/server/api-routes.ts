import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigStore } from "./config.js";
import { handleConfigApi } from "./api-config-routes.js";
import { handleRuntimeApi, type FetchClaudeModels } from "./api-runtime-routes.js";
import { sendJson } from "./http-utils.js";
import type { RequestLogger } from "./logger.js";
import type { StudioEventBroadcaster } from "./studio-events.js";
import type { DebugCaptureWriter } from "./debug-capture.js";

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  studioEvents: StudioEventBroadcaster,
  fetchClaudeModels: FetchClaudeModels
): Promise<void> {
  if (await handleConfigApi(req, res, url, configStore, logger, captureWriter, studioEvents)) {
    return;
  }

  if (
    await handleRuntimeApi(
      req,
      res,
      url,
      configStore,
      logger,
      captureWriter,
      studioEvents,
      fetchClaudeModels
    )
  ) {
    return;
  }

  sendJson(res, 404, { error: "API endpoint not found." });
}
