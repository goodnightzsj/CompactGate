import http, { type IncomingMessage } from "node:http";
import { cleanup } from "./server-test-lifecycle.js";

export async function openSseStream(url: string) {
  const target = new URL(url);
  const queue: Array<{ event: string; payload: unknown }> = [];
  const waiters = new Map<
    string,
    Array<{ reject: (error: Error) => void; resolve: (value: unknown) => void }>
  >();
  let buffer = "";
  let response: IncomingMessage | null = null;
  const request = await new Promise<http.ClientRequest>((resolve, reject) => {
    const nextRequest = http.get(target, (incoming) => {
      response = incoming;
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        buffer += chunk;

        while (buffer.includes("\n\n")) {
          const separator = buffer.indexOf("\n\n");
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) {
            continue;
          }

          const pending = waiters.get(parsed.event);
          if (pending && pending.length > 0) {
            pending.shift()?.resolve(parsed.payload);
            continue;
          }

          queue.push(parsed);
        }
      });
      resolve(nextRequest);
    });

    nextRequest.once("error", reject);
  });

  request.on("error", (error) => {
    for (const [, pending] of waiters) {
      for (const waiter of pending) {
        waiter.reject(error);
      }
    }
    waiters.clear();
  });

  cleanup.push(async () => {
    request.destroy();
    response?.destroy();
  });

  return {
    close: async () => {
      request.destroy();
      response?.destroy();
    },
    waitForEvent(event: string, timeoutMs = 1500) {
      const queuedIndex = queue.findIndex((item) => item.event === event);
      if (queuedIndex >= 0) {
        const [queued] = queue.splice(queuedIndex, 1);
        return Promise.resolve(queued.payload);
      }

      return new Promise<unknown>((resolve, reject) => {
        let wrappedResolve: ((value: unknown) => void) | undefined;
        const timeout = setTimeout(() => {
          const pending = waiters.get(event) ?? [];
          waiters.set(
            event,
            pending.filter((waiter) => waiter.resolve !== wrappedResolve)
          );
          reject(new Error(`Timed out waiting for SSE event ${event}.`));
        }, timeoutMs);
        wrappedResolve = (value: unknown) => {
          clearTimeout(timeout);
          resolve(value);
        };
        const wrappedReject = (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        };
        const pending = waiters.get(event) ?? [];
        pending.push({ resolve: wrappedResolve, reject: wrappedReject });
        waiters.set(event, pending);
      });
    }
  };
}

function parseSseFrame(frame: string): { event: string; payload: unknown } | null {
  const lines = frame.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":") || line.length === 0) {
      continue;
    }

    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    payload: JSON.parse(dataLines.join("\n")) as unknown
  };
}
