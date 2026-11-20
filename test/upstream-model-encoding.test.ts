import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { startApp, startUpstream } from "./helpers/server-test-utils.js";
import { requestJson, UpstreamStatusError } from "../src/server/upstream-json-client.js";
import { MAX_COMPLETE_UPSTREAM_RESPONSE_BYTES } from "../src/server/upstream-response-buffer.js";

const encodings = [
  { name: "identity", encode: (body: Buffer) => body },
  { name: "gzip", encode: gzipSync },
  { name: "zstd", encode: zstdCompressSync },
  { name: "br", encode: brotliCompressSync },
  { name: "deflate", encode: deflateSync }
];
describe.each(["openai", "claude"])("%s model catalog encoding", scope => {
  it.each(encodings)("reads negotiated $name JSON", async ({ name, encode }) => {
    const requested: string[] = [];
    const upstream = await startUpstream((req, res) => {
      requested.push(String(req.headers["accept-encoding"]));
      res.writeHead(200, { "content-type": "application/json", "content-encoding": name });
      res.end(encode(Buffer.from(JSON.stringify({ data: [{ id: "synthetic-model" }] }))));
    });
    const app = await startApp(upstream.url, undefined, {
      primary: { extra_headers: { "accept-encoding": name } },
      claude: { primary: { base_url: upstream.url, extra_headers: { "accept-encoding": name } } }
    });
    const response = await fetch(`${app.url}/api/${scope}/models`);
    const body = await response.json();
    expect(requested).toEqual([name]);
    expect(body).toMatchObject({ models: ["synthetic-model"], error: null });
  });
});

it.each(["br", "deflate", "gzip", "zstd", "unsupported"])("reports invalid %s explicitly", async encoding => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-encoding": encoding });
    res.end('{"data":[]}');
  });
  await expect(requestJson(new URL(upstream.url), {}, 1000)).rejects.toThrow("Failed to decode upstream JSON response");
});

it.each([gzipSync, zstdCompressSync])("retains legacy magic-byte decoding without content-encoding", async encode => {
  const upstream = await startUpstream((_req, res) => res.end(encode(Buffer.from('{"data":[]}'))));
  await expect(requestJson(new URL(upstream.url), {}, 1000)).resolves.toEqual({ data: [] });
});

it("bounds decoded compression and preserves HTTP errors before decoding", async () => {
  const compressed = deflateSync(Buffer.alloc(MAX_COMPLETE_UPSTREAM_RESPONSE_BYTES + 1, 0x20));
  const upstream = await startUpstream((req, res) => {
    res.writeHead(req.url === "/unauthorized" ? 401 : 200, { "content-encoding": "deflate" });
    res.end(compressed);
  });
  await expect(requestJson(new URL(upstream.url), {}, 1000)).rejects.toThrow(`exceeds ${MAX_COMPLETE_UPSTREAM_RESPONSE_BYTES} bytes`);
  await expect(requestJson(new URL("/unauthorized", upstream.url), {}, 1000)).rejects.toBeInstanceOf(UpstreamStatusError);
});
