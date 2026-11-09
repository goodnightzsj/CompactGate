import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { readLogStats, type LogStatsOptions } from "./logger-analytics.js";

const db = new DatabaseSync(workerData.databasePath, { readOnly: true });
db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000");
parentPort!.on("message", ({ id, options }: { id: number; options: LogStatsOptions }) => {
  try {
    parentPort!.postMessage({ id, snapshot: readLogStats(db, options) });
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
