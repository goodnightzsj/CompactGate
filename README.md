# CompactGate

CompactGate is a local OpenAI-compatible reverse proxy for Codex CLI compact requests.

Codex can point its OpenAI-compatible `base_url` at CompactGate, while CompactGate routes normal `/v1/*` traffic to a primary upstream and can route `POST /v1/responses/compact` to either a separate compact upstream or the same primary upstream. Compact requests can rewrite the JSON `model` automatically or use a manual override.

If your primary API already supports the compact model you want to use, set `compact.upstream_mode` to `"primary"`. That disables separate compact upstream routing while keeping Codex-facing `/v1/responses/compact` compatibility.

The project also ships CompactGate Studio, a single-page local console for editing live config, previewing routes, checking health, and inspecting recent request logs without recording prompt bodies.

## Current Features

- Routes normal `/v1/*` traffic to a primary upstream and compact traffic to either a dedicated compact upstream or the same primary upstream.
- Rewrites compact request models in linked or fully custom mode.
- Preserves streaming for normal upstream responses while removing `stream` from compact request bodies.
- Persists recent route logs to SQLite and pushes new log entries into Studio over Server-Sent Events.
- Supports direct saved API keys, environment-variable fallback keys, and request-by-request upstream route diagnostics.
- Optionally captures full upstream request and response payloads to disk for debugging when explicitly enabled.
- Repairs split-mode follow-up requests after compaction by translating readable compact state into assistant summary messages before forwarding to the primary upstream.

## Quick Start

```bash
npm install
cp compactgate.example.json compactgate.json
npm run build
npm start
```

Open `http://127.0.0.1:7865/` for CompactGate Studio.

Use this base URL in Codex:

```toml
model_provider = "compactgate"
model = "gpt-5.5"

[model_providers.compactgate]
name = "OpenAI"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://127.0.0.1:7865/v1"
```

The provider `name` must stay `"OpenAI"` so Codex uses the remote `/v1/responses/compact` path.

## Configuration

CompactGate reads `compactgate.json` by default. Override the path with `COMPACTGATE_CONFIG`.

```bash
COMPACTGATE_CONFIG=/path/to/compactgate.json npm start
```

Request logs are persisted to SQLite. By default CompactGate writes `compactgate-logs.sqlite` next to the active config file. Override that path with `COMPACTGATE_LOG_DB`.

```bash
COMPACTGATE_LOG_DB=/path/to/compactgate-logs.sqlite npm start
```

Full request and response capture is disabled by default. Enable it only for debugging by pointing `COMPACTGATE_CAPTURE_DIR` at a local directory.

```bash
COMPACTGATE_CAPTURE_DIR=/path/to/captures npm start
```

Example config:

```json
{
  "listen": "127.0.0.1:7865",
  "primary": {
    "base_url": "https://primary.example/v1",
    "api_key": "sk-primary-example",
    "api_key_env": "PRIMARY_API_KEY"
  },
  "compact": {
    "base_url": "https://compact.example/v1",
    "api_key": "sk-compact-example",
    "api_key_env": "COMPACT_API_KEY",
    "upstream_mode": "split",
    "model_mode": "linked",
    "model_template": "{model}-openai-compact",
    "model_override": ""
  },
  "timeouts": {
    "primary_ms": 120000,
    "compact_ms": 900000
  },
  "logging": {
    "redact_body": true,
    "keep_recent": 200
  }
}
```

CompactGate Studio now lets you enter and save one API key directly under each upstream URL. Saved keys are written to `compactgate.json` and take priority over environment variables.

If you still prefer shell-based secrets, `api_key_env` remains as an optional fallback:

```bash
export PRIMARY_API_KEY="..."
export COMPACT_API_KEY="..."
```

The management API reports whether a saved key or environment variable is active, but the default `GET /api/config` response does not return plaintext API keys.

## Routing

Normal requests:

```text
POST /v1/responses -> primary.base_url + /responses
```

Compact requests:

```text
POST /v1/responses/compact -> compact.base_url + /responses/compact
```

Set `compact.upstream_mode` to control where compact requests go:

```text
split   -> compact.base_url + /responses/compact
primary -> primary.base_url + /responses/compact
```

Use `primary` mode when the primary upstream already provides the compact-capable model. CompactGate will still rewrite the model according to `model_mode`.

In linked mode, CompactGate rewrites compact request models with `model_template`:

```text
gpt-5.5 -> gpt-5.5-openai-compact
gpt-5.4 -> gpt-5.4-openai-compact
```

In custom mode, CompactGate uses `compact.model_override` for every compact request.

CompactGate removes `stream` from compact request JSON bodies. Normal `/v1/*` proxying does not buffer the upstream response, so streaming responses remain streamed.

Debug response headers:

```text
x-compactgate-route: primary
x-compactgate-route: compact
x-compactgate-model: gpt-5.5-openai-compact
x-compactgate-request-id: ...
```

## Management API

`GET /api/health`

Returns CompactGate status plus primary and compact upstream configuration status.

`GET /api/config`

Returns current runtime config plus key source metadata. Saved API keys are redacted from this response.

`GET /api/config/export`

Returns the full saved config, including persisted API keys. CompactGate Studio uses this only for explicit config export.

`PATCH /api/config`

Hot-patches config and writes it to disk. Restart is not required. This endpoint can update `primary.api_key`, `compact.api_key`, and the optional `api_key_env` fallback fields.

To disable separate compact upstream routing at runtime:

```json
{
  "compact": {
    "upstream_mode": "primary"
  }
}
```

`POST /api/test-route`

Previews route selection and model rewriting.

```json
{
  "path": "/v1/responses/compact",
  "body": {
    "model": "gpt-5.5",
    "stream": true
  }
}
```

`GET /api/logs/recent`

Returns recent request logs. Add `?route=primary` or `?route=compact` to filter. Logs are backed by SQLite and survive process restarts, while request bodies remain excluded.

`GET /api/events`

Returns a long-lived Server-Sent Events stream for CompactGate Studio or lightweight integrations.

- `snapshot` event: current public config, health, and recent logs
- `log` event: one newly completed proxied request log entry

The Studio page uses this stream for live log updates and falls back to polling only when `EventSource` is unavailable.

## Development

Run the backend:

```bash
npm run dev
```

Run the Vite dev server in another terminal:

```bash
npx vite --host 127.0.0.1 --port 5173
```

Run verification:

```bash
npm test
npm run build
```

## Troubleshooting

If Codex does not call `/v1/responses/compact`, confirm the provider block uses `name = "OpenAI"` and `wire_api = "responses"`.

If compact requests hit the wrong upstream, open CompactGate Studio and use Inspector with `/v1/responses/compact` and `{ "model": "gpt-5.5" }`.

If your primary API already has a compact model, switch Compact upstream mode to `Primary` in Studio or set `compact.upstream_mode` to `"primary"`.

If the upstream rejects authentication, first confirm the saved API key under that upstream is correct. If the field is blank, confirm the fallback environment variable is exported in the same shell that starts CompactGate.

If Compact upstream mode is `primary`, Compact requests reuse the primary credential source even if `compact.api_key` or `compact.api_key_env` is configured.

If route logs do not show prompt content, that is expected. CompactGate logs route metadata by default and intentionally avoids request body logging.

If split mode fails after a prior compact operation from another upstream, make sure you are running a recent CompactGate build. Current builds translate readable compact state into assistant summary messages before the next normal request reaches the primary upstream.
