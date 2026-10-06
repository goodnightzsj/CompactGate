export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    if (response.ok || !(cause instanceof SyntaxError)) throw cause;
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim(), { cause });
  }

  if (!response.ok) {
    throw new Error(readApiError(payload) ?? `HTTP ${response.status} ${response.statusText}`.trim());
  }

  return payload as T;
}

function readApiError(payload: unknown): string | null {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }

  return null;
}

export function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
