export type UpstreamPathMode = "replace-client-api-root" | "append-request-path";

const CLIENT_API_ROOT = "/v1";

/**
 * Resolve one upstream URL from a configured base plus the client's path and
 * query string. The request's parameters win per name, but any query string the
 * base_url carries — a key or a version pin — is preserved, because validation
 * accepts such a base_url and silently dropping it breaks the upstream call.
 */
export function buildUpstreamUrlWithMode(
  baseUrl: string,
  requestPath: string,
  search: string,
  mode: UpstreamPathMode
): URL {
  const base = new URL(baseUrl);
  base.pathname = resolveUpstreamPath(base.pathname, requestPath, mode);
  const requestSearch = new URLSearchParams(search);
  for (const name of new Set(requestSearch.keys())) {
    base.searchParams.delete(name);
    for (const value of requestSearch.getAll(name)) {
      base.searchParams.append(name, value);
    }
  }

  return base;
}

export function resolveUpstreamPath(
  basePathname: string,
  requestPath: string,
  mode: UpstreamPathMode
): string {
  const basePath = trimTrailingSlashes(basePathname);
  const normalizedRequestPath = withLeadingSlash(requestPath);
  const shouldRemoveClientApiRoot =
    mode === "replace-client-api-root" || endsWithPathSegment(basePath, CLIENT_API_ROOT);
  const suffix = shouldRemoveClientApiRoot
    ? stripExactPathPrefix(normalizedRequestPath, CLIENT_API_ROOT)
    : normalizedRequestPath;

  return joinPathBoundary(basePath, suffix);
}

function stripExactPathPrefix(pathname: string, prefix: string): string {
  if (pathname === prefix) {
    return "/";
  }
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname;
}

function endsWithPathSegment(pathname: string, segment: string): boolean {
  return pathname === segment || pathname.endsWith(segment);
}

function joinPathBoundary(basePathname: string, suffix: string): string {
  const normalizedSuffix = withLeadingSlash(suffix);
  return basePathname ? `${basePathname}${normalizedSuffix}` : normalizedSuffix;
}

function trimTrailingSlashes(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "/" ? "" : trimmed;
}

function withLeadingSlash(pathname: string): string {
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}
