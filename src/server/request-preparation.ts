import type { IncomingMessage, ServerResponse } from "node:http";
import { UpstreamRequestError } from "./upstream-client.js";

export interface RequestPreparationBudget {
  startedAt: number;
  timeoutMs: number;
  timeoutMessage: string;
  req?: IncomingMessage;
  res?: ServerResponse;
}

/** Stop this request's wait without cancelling work shared by other requests. */
export async function waitForRequestPreparation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  budget: RequestPreparationBudget
): Promise<T> {
  const controller = new AbortController();
  const failure = (cancelled: boolean) => new UpstreamRequestError(
    cancelled ? "Client disconnected during request preparation." : budget.timeoutMessage,
    { kind: cancelled ? "client_cancel" : "timeout", status: null, responseBody: Buffer.alloc(0),
      responseBodyTruncated: false, responseHeaders: {}, firstTokenMs: null, streamSummary: null,
      clientDisconnectPhase: cancelled ? "before_terminal" : "none" }
  );
  const remaining = budget.startedAt + budget.timeoutMs - performance.now();
  if (budget.res?.destroyed) throw failure(true);
  if (remaining <= 0) throw failure(false);
  let rejectWait!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectWait = reject; });
  const abort = (cancelled: boolean) => {
    const error = failure(cancelled);
    controller.abort(error);
    if (budget.req && !budget.req.complete && budget.res && !budget.res.headersSent) {
      budget.req.pause();
      budget.res.shouldKeepAlive = false;
      budget.res.setHeader("connection", "close");
    }
    rejectWait(error);
  };
  const onClose = () => abort(true);
  const timer = setTimeout(() => abort(false), remaining);
  budget.res?.once("close", onClose);
  try {
    return await Promise.race([operation(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    budget.res?.off("close", onClose);
  }
}
