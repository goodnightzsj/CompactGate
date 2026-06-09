export function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "invalid";
  }
}

export function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
