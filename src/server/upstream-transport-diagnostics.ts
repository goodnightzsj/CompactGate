import { randomUUID } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { StreamOutcome } from "../shared/types.js";
import type { DrainOutcome } from "./upstream-proxy-agent.js";

type Stage = "socket_ready_ms" | "request_sent_ms" | "headers_ms" | "first_body_byte_ms" |
  "terminal_observed_ms" | "result_settled_ms" | "http_end_ms" | "request_closed_ms" | "drain_started_ms";

/** Opt-in attempt metadata only: never serialize URLs, headers, bodies or error messages. */
export function createUpstreamTransportDiagnostics(upstream: URL, requestId: string | undefined, requestStartedAt: number) {
  if (process.env.COMPACTGATE_TRANSPORT_DIAGNOSTICS !== "1") return null;
  const startedAt = performance.now();
  const stages: Record<Stage, number | null> = {
    socket_ready_ms: null, request_sent_ms: null, headers_ms: null, first_body_byte_ms: null,
    terminal_observed_ms: null, result_settled_ms: null, http_end_ms: null, request_closed_ms: null, drain_started_ms: null
  };
  const sample = {
    type: "upstream_transport", attempt_id: randomUUID(), request_id: requestId ?? null,
    time: new Date().toISOString(), upstream_host: upstream.host,
    request_elapsed_at_start_ms: Math.max(0, Math.round(startedAt - requestStartedAt)),
    reused_socket: false, upstream_status: null as number | null,
    outcome: null as StreamOutcome | null, close_reason: null as string | null,
    drain_outcome: null as DrainOutcome | "pending" | null, drain_bytes: 0
  };
  let emitted = false;
  const mark = (stage: Stage) => { stages[stage] ??= Math.max(0, Math.round(performance.now() - startedAt)); };
  const flush = () => {
    if (emitted || stages.result_settled_ms === null || stages.request_closed_ms === null || sample.drain_outcome === "pending") return;
    emitted = true;
    console.info(JSON.stringify({ ...sample, ...stages }));
  };
  return {
    mark,
    attachRequest(request: ClientRequest, tunneled: boolean) {
      request.once("socket", (socket) => {
        sample.reused_socket = request.reusedSocket;
        const ready = () => mark("socket_ready_ms");
        // The custom CONNECT agent hands Node a socket only after TLS is ready.
        if (tunneled || request.reusedSocket || (upstream.protocol === "http:" && !socket.connecting)) ready();
        else {
          const event = upstream.protocol === "https:" ? "secureConnect" : "connect";
          socket.once(event, ready);
          request.once("close", () => socket.off(event, ready));
        }
      });
      request.once("finish", () => mark("request_sent_ms"));
      request.once("close", () => {
        mark("request_closed_ms");
        sample.close_reason ??= stages.http_end_ms === null ? "request_closed" : "http_complete";
        flush();
      });
    },
    attachResponse(response: IncomingMessage) {
      mark("headers_ms");
      sample.upstream_status = response.statusCode ?? null;
      response.once("end", () => mark("http_end_ms"));
    },
    settle(outcome: StreamOutcome) {
      sample.outcome = outcome;
      mark("result_settled_ms");
      flush();
    },
    closing(reason: string) { sample.close_reason = reason; },
    startDrain() { sample.drain_outcome = "pending"; mark("drain_started_ms"); },
    finishDrain(outcome: DrainOutcome, bytes: number) {
      sample.drain_outcome = outcome;
      sample.drain_bytes = bytes;
      sample.close_reason = outcome === "complete" ? "http_complete" : `drain_${outcome}`;
      flush();
    }
  };
}
