export {
  assertCaptured,
  captureBody,
  type CapturedRequest,
  type CaptureFixtureRecord,
  readCaptureRecords,
  waitForCaptureRecords
} from "./server-test-capture.js";
export {
  fetchLogPage,
  fetchRecentLogs,
  readLatestLogBodyFields,
  readLogCount,
  seedLegacyLogDatabase,
  sendCompactRequest,
  waitForLogEntry
} from "./server-test-logs.js";
export {
  cleanup,
  cleanupEnvKeys,
  isRecord,
  setEnv,
  startApp,
  startAppInDir
} from "./server-test-lifecycle.js";
export {
  startClaudeUpstream,
  startConnectProxy,
  startHttpsClaudeUpstream,
  startUpstream
} from "./server-test-upstreams.js";
export { openSseStream } from "./server-test-sse.js";

export function claudeManualCompactPrompt() {
  return [
    "Your task is to create a detailed summary of the conversation so far.",
    "CRITICAL: Respond with TEXT ONLY.",
    "<summary>",
    "Summarize the previous context.",
    "</summary>"
  ].join("\n");
}
