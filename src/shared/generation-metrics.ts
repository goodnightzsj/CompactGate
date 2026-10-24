import { isRecord } from "./records.js";
import type { GenerationSample } from "./types.js";

// Very short, coalesced streams do not provide a useful rate; retain their measurements.
export const MIN_GENERATION_DURATION_MS = 100;

export function readGenerationSample(value: unknown): GenerationSample | null {
  if (!isRecord(value)) return null;
  const { first_output_ms, duration_ms, output_tokens } = value;
  if (typeof first_output_ms !== "number" || !Number.isFinite(first_output_ms) || first_output_ms < 0 ||
    typeof duration_ms !== "number" || !Number.isFinite(duration_ms) || duration_ms < 0 ||
    typeof output_tokens !== "number" || !Number.isSafeInteger(output_tokens) || output_tokens < 0) return null;
  return { first_output_ms, duration_ms, output_tokens };
}

export function generationTokensPerSecond(value: unknown): number | null {
  const sample = readGenerationSample(value);
  return sample && sample.duration_ms >= MIN_GENERATION_DURATION_MS
    ? sample.output_tokens * 1000 / sample.duration_ms : null;
}
