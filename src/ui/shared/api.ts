export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });

  const payload = (await response.json()) as T | { error?: string };

  if (!response.ok) {
    throw new Error(readApiError(payload) ?? response.statusText);
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
