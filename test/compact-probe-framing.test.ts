import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { captureBody, postJson, startApp, startUpstream } from "./helpers/server-test-utils.js";

it.each(["plain", "multiline", "gzip-json", "gzip-sse", "br-json", "br-sse", "deflate-json", "deflate-sse", "zstd-json", "zstd-sse"])("recognizes valid Anthropic compaction in %s", async format => {
  const item = { type: "compaction", content: "Synthetic compressed conversation." };
  const start = JSON.stringify({ type: "content_block_start", index: 0, content_block: item });
  const frame = format === "multiline" ? start.replace(',"content_block"', ',\ndata: "content_block"') : start;
  const sse = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_synthetic", role: "assistant", content: [] } })}\n\n` +
    `event: content_block_start\ndata: ${frame}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
  const json = format.endsWith("-json");
  const body = json ? JSON.stringify({ type: "message", role: "assistant", content: [item], stop_reason: "end_turn" }) : sse;
  const encoding = format.split("-")[0];
  const compressor = { gzip: gzipSync, br: brotliCompressSync, deflate: deflateSync, zstd: zstdCompressSync }[encoding];
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    res.writeHead(200, { "content-type": json ? "application/json" : "text/event-stream",
      ...(compressor ? { "content-encoding": encoding } : {}) });
    res.end(compressor ? compressor(body) : body);
  });
  const app = await startApp(upstream.url, upstream.url, { compact: { upstream_protocol: "anthropic_messages", model_template: "{model}" } });
  const response = await postJson(app.url, "/api/compact/capability-probe", { model: "synthetic-model" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ supported: true, compaction_item_count: 1, failure_reason: null });
});
