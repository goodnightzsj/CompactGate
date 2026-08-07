export function safeHost(value: string): string {
  return URL.parse(value)?.host ?? "invalid";
}

export function isValidBaseUrl(value: string): boolean {
  const protocol = URL.parse(value)?.protocol;
  return protocol === "http:" || protocol === "https:";
}
