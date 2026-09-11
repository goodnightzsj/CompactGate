import type { IncomingMessage, ServerResponse } from "node:http";
import { OAUTH_PROVIDERS } from "../shared/oauth.js";
import { ConfigError, type ConfigStore } from "./config.js";
import { isRecord, readJsonBody, sendJson } from "./http-utils.js";
import { sendOAuthCallbackPage } from "./oauth-store.js";
import { DEFAULT_CONFIG } from "./config-defaults.js";
import { fetchOAuthModels } from "./oauth-transport.js";

export async function handleOAuthApi(
  req: IncomingMessage, res: ServerResponse, url: URL, configStore: ConfigStore,
  notify: () => void
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/oauth/")) return false;
  res.setHeader("cache-control", "no-store");
  const oauth = configStore.oauth;
  if (req.method === "GET" && url.pathname === "/api/oauth/providers") {
    sendJson(res, 200, { providers: OAUTH_PROVIDERS });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/oauth/accounts") {
    sendJson(res, 200, { accounts: oauth.list() });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/oauth/sessions") {
    const body = await readOAuthBody(req);
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", abort);
    try {
      const session = await oauth.start(body, `http://${req.headers.host}`, controller.signal);
      sendJson(res, 201, session);
    } finally { res.off("close", abort); }
    return true;
  }
  const callback = /^\/api\/oauth\/callback\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
  if (req.method === "GET" && callback) {
    try {
      const result = await oauth.complete(callback[1], new URL(req.url!, `http://${req.headers.host}`).href);
      if (result.status === "connected") notify();
      sendOAuthCallbackPage(res, result.status === "connected");
    } catch { sendOAuthCallbackPage(res, false); }
    return true;
  }
  const session = /^\/api\/oauth\/sessions\/([a-zA-Z0-9_-]+)(?:\/(poll|complete))?$/.exec(url.pathname);
  if (session) {
    if (req.method === "GET" && !session[2]) {
      sendJson(res, 200, oauth.session(session[1]));
      return true;
    }
    if (req.method === "DELETE" && !session[2]) {
      sendJson(res, 200, oauth.cancel(session[1]));
      return true;
    }
    if (req.method === "POST" && (session[2] === "poll" || session[2] === "complete")) {
      const previous = oauth.session(session[1]).status;
      const result = session[2] === "poll" ? await oauth.poll(session[1])
        : await oauth.complete(session[1], requiredField(await readOAuthBody(req), "callback_url"));
      if (result.status === "connected" && previous !== "connected") notify();
      sendJson(res, 200, result);
      return true;
    }
  }
  const account = /^\/api\/oauth\/accounts\/([a-zA-Z0-9_-]+)(?:\/(refresh|models))?$/.exec(url.pathname);
  if (account) {
    if (req.method === "GET" && account[2] === "models") {
      const connection = oauth.get(account[1]);
      if (!connection) throw new ConfigError("OAuth connection was not found.", 404);
      sendJson(res, 200, await fetchOAuthModels({
        ...DEFAULT_CONFIG.primary, base_url: connection.base_url,
        upstream_protocol: connection.upstream_protocol, oauth_account_id: connection.id
      }, oauth, 30_000));
      return true;
    }
    if (req.method === "POST" && account[2] === "refresh") {
      await oauth.refresh(account[1]);
      notify();
      sendJson(res, 200, { account: oauth.get(account[1]) });
      return true;
    }
    if (req.method === "DELETE" && !account[2]) {
      const body = await readOAuthBody(req);
      if (body.confirm !== true) throw new ConfigError("Disconnecting an OAuth connection requires confirm=true.");
      await oauth.disconnect(account[1]);
      notify();
      sendJson(res, 200, { account: oauth.get(account[1]) });
      return true;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/oauth/profiles") {
    const body = await readOAuthBody(req);
    if (body.scope !== "codex" && body.scope !== "claude") throw new ConfigError("OAuth profile scope must be codex or claude.");
    await configStore.saveOAuthProfile(
      body.scope, requiredField(body, "account_id"), requiredField(body, "name"),
      requiredField(body, "model"), requiredField(body, "revision")
    );
    notify();
    sendJson(res, 201, configStore.toPublicConfig());
    return true;
  }
  return false;
}

async function readOAuthBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body: unknown;
  try { body = await readJsonBody(req); }
  catch (error) {
    if (error instanceof SyntaxError) throw new ConfigError("OAuth request body must contain valid JSON.");
    throw error;
  }
  if (!isRecord(body)) throw new ConfigError("OAuth request body must be a JSON object.");
  return body;
}

function requiredField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new ConfigError(`OAuth request requires ${field}.`);
  return value;
}
