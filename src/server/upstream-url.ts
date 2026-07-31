export type UpstreamPathMode = "replace-client-api-root" | "append-request-path";

const CLIENT_API_ROOT = "/v1";

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
