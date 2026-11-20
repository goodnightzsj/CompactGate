import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { readLogStats } from "./logger-analytics.js";
import { readLogPage } from "./logger-page.js";
import type { LogReadRequest } from "./log-stats-reader.js";

const db = new DatabaseSync(workerData.databasePath, { readOnly: true });
db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000");
parentPort!.on("message", ({ id, ...request }: { id: number } & LogReadRequest) => {
  try {
    const snapshot = request.kind === "page" ? readLogPage(db, request.options) : readLogStats(db, request.options);
    parentPort!.postMessage({ id, snapshot });
  } catch (error) {
    parentPort!.postMessage({
      id,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
});
parentPort!.once("close", () => db.close());
