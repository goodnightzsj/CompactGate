import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { sendJson } from "./http-utils.js";

const STATIC_MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const publicDir = resolvePublicDir();
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(res, 400, { error: "Malformed URL path." });
    return;
  }
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safeRelativePath = requested.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, safeRelativePath);
  const fallbackPath = path.resolve(publicDir, "index.html");
  const existingFilePath = isWithinDirectory(publicDir, filePath) && existsSync(filePath)
    ? filePath
    : null;
  const shouldFallbackToIndex = existingFilePath === null && isFrontendRoute(pathname);
  const targetPath = existingFilePath ?? (shouldFallbackToIndex ? fallbackPath : null);

  if (targetPath === null) {
    sendJson(res, 404, { error: "File not found." });
    return;
  }

  if (!existsSync(targetPath)) {
    sendJson(res, 200, {
      name: "CompactGate",
      message: "Build the Studio UI with npm run build, or run Vite during development."
    });
    return;
  }

  const stat = statSync(targetPath);
  if (!stat.isFile()) {
    sendJson(res, 404, { error: "File not found." });
    return;
  }

  if (res.destroyed) return;
  const source = req.method === "HEAD" ? null : createReadStream(targetPath);
  const controller = new AbortController();
  const disconnected = () => controller.abort();
  const timeoutError = new Error("Static asset did not become readable within 5 seconds.");
  const deadline = source ? setTimeout(() => controller.abort(timeoutError), 5_000) : undefined;
  res.once("close", disconnected);
  try {
    // The stream owns its descriptor. Wait for a first read before handing it
    // the response, so open/read failures never inherit immutable asset headers.
    if (source) await once(source, "readable", { signal: controller.signal });
    clearTimeout(deadline);
    if (res.destroyed) return;
    res.statusCode = 200;
    res.setHeader(
      "content-type",
      STATIC_MIME_TYPES[path.extname(targetPath)] ?? "application/octet-stream"
    );
    res.setHeader("content-length", String(stat.size));
    res.setHeader("cache-control", cacheControlForTarget(targetPath, fallbackPath));

    if (!source) {
      res.end();
      return;
    }
    await pipeline(source, res, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.reason === timeoutError && !res.destroyed) {
      res.setHeader("cache-control", "no-store");
      sendJson(res, 503, { error: timeoutError.message });
      return;
    }
    if (!controller.signal.aborted || !(error instanceof Error) || error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(deadline);
    res.off("close", disconnected);
    source?.destroy();
  }
}

function resolvePublicDir(): string {
  const candidates = [
    path.resolve(import.meta.dirname, "../public"),
    path.resolve(process.cwd(), "dist/public"),
    path.resolve(process.cwd(), "public")
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function isWithinDirectory(directory: string, filePath: string): boolean {
  const relativePath = path.relative(directory, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isFrontendRoute(pathname: string): boolean {
  return pathname === "/" || (!pathname.startsWith("/assets/") && path.extname(pathname) === "");
}

function cacheControlForTarget(targetPath: string, fallbackPath: string): string {
  if (targetPath === fallbackPath) {
    return "no-cache";
  }

  return targetPath.includes(`${path.sep}assets${path.sep}`)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}
