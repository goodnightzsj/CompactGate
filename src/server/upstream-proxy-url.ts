export function parseHttpConnectProxyUrl(value: string): URL {
  let proxy: URL;
  try {
    proxy = new URL(value);
  } catch {
    throw new Error("Proxy URL must be a valid http URL.");
  }

  if (
    proxy.protocol !== "http:" ||
    !proxy.hostname ||
    (proxy.pathname !== "" && proxy.pathname !== "/") ||
    proxy.search.length > 0 ||
    proxy.hash.length > 0
  ) {
    throw new Error("Proxy URL must be an http URL without a path, query, or fragment.");
  }

  try {
    decodeURIComponent(proxy.username);
    decodeURIComponent(proxy.password);
  } catch {
    throw new Error("Proxy credentials contain malformed percent-encoding.");
  }

  return proxy;
}
