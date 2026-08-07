import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigStore } from "./config.js";
import { handleConfigApi } from "./api-config-routes.js";
import { handleRuntimeApi } from "./api-runtime-routes.js";
import { sendJson } from "./http-utils.js";
import type { RequestLogger } from "./logger.js";
import type { StudioEventBroadcaster } from "./studio-events.js";
import type { DebugCaptureWriter } from "./debug-capture.js";
import type { PrimaryFailoverState } from "./primary-failover.js";
import type { CodexVersionMonitor } from "./codex-version.js";

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  studioEvents: StudioEventBroadcaster,
  primaryFailover: PrimaryFailoverState,
  codexVersionMonitor: CodexVersionMonitor
): Promise<void> {
  if (await handleConfigApi(
    req,
    res,
    url,
    configStore,
    logger,
    captureWriter,
    studioEvents,
    codexVersionMonitor,
    primaryFailover
  )) {
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
      primaryFailover,
      codexVersionMonitor
    )
  ) {
    return;
  }

  sendJson(res, 404, { error: "API endpoint not found." });
}
