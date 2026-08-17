/**
 * Joins the `data:` lines of each SSE frame into one payload string,
 * skipping empty frames and the `[DONE]` sentinel.
 */
export function sseDataFrames(text: string): string[] {
  const payloads: string[] = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }
    payloads.push(data);
  }
  return payloads;
}
