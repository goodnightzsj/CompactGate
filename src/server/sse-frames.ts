import { StringDecoder } from "node:string_decoder";

export const SSE_LINE_ENDING = /\r\n|[\r\n]/;
const SSE_FRAME_BOUNDARY = /(?:\r\n|\r(?!\n)|\n){2}/;

/** Decode once, scan only new text, and join only at a frame boundary. */
export function createSseFrameDecoder(onFrame: (frame: string) => void, checkBytes?: (bytes: number) => void) {
  const decoder = new StringDecoder("utf8");
  const pieces: string[] = [];
  const separatorPattern = new RegExp(SSE_FRAME_BOUNDARY, "g");
  let pendingBytes = 0;
  let separatorTail = "";
  let skipLF = false;

  function drain(chunk: string): void {
    if (!chunk) return;
    if (skipLF && chunk.startsWith("\n")) chunk = chunk.slice(1);
    skipLF = false;
    const text = separatorTail + chunk;
    separatorPattern.lastIndex = 0;
    let offset = 0;
    for (;;) {
      const separator = separatorPattern.exec(text);
      if (!separator) break;
      const segment = text.slice(offset, separator.index);
      pendingBytes += Buffer.byteLength(segment);
      checkBytes?.(pendingBytes);
      pieces.push(segment);
      onFrame(pieces.join(""));
      pieces.length = 0;
      pendingBytes = 0;
      offset = separator.index + separator[0].length;
      skipLF = offset === text.length && separator[0].endsWith("\r");
    }
    const remainder = text.slice(offset);
    separatorTail = /\r\n$|[\r\n]$/.exec(remainder)?.[0] ?? "";
    const segment = remainder.slice(0, remainder.length - separatorTail.length);
    pendingBytes += Buffer.byteLength(segment);
    // A partial delimiter is not payload; count it only if EOF makes it a tail.
    checkBytes?.(pendingBytes);
    if (segment) pieces.push(segment);
  }
  return {
    write(chunk: Buffer): void { drain(decoder.write(chunk)); },
    // A passthrough may append its own event. Return only the missing part of the delimiter.
    end(): string {
      drain(decoder.end());
      checkBytes?.(pendingBytes + separatorTail.length);
      const raw = pieces.join("") + separatorTail;
      if (raw.trim()) onFrame(raw);
      const missingSeparator = !raw ? "" : separatorTail.includes("\n") ? "\n" : "\n\n";
      pieces.length = 0;
      separatorTail = "";
      pendingBytes = 0;
      return missingSeparator;
    }
  };
}

/**
 * Joins the `data:` lines of each SSE frame into one payload string,
 * skipping empty frames and the `[DONE]` sentinel.
 */
export function sseDataFrames(text: string): string[] {
  const payloads: string[] = [];
  for (const frame of text.split(SSE_FRAME_BOUNDARY)) {
    const data = frame
      .split(SSE_LINE_ENDING)
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
