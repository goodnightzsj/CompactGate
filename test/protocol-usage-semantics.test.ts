import { describe, expect, it } from "vitest";
import {
  anthropicUsageToResponses,
  openAiUsageToAnthropic
} from "../src/server/protocol-conversion.js";

/**
 * The two conventions disagree on what `input_tokens` covers: OpenAI's is the
 * whole prompt including anything served from cache, Anthropic's is only the
 * fresh remainder with the cache counters additive on top. Translating the
 * field names without translating that changes the token total, and both
 * proxies derive their logged usage from the converted body.
 */
describe("usage conversion preserves the token total", () => {
  it("subtracts cached tokens from the Anthropic input when coming from OpenAI", () => {
    const usage = openAiUsageToAnthropic({
      input_tokens: 10_000,
      output_tokens: 1_500,
      total_tokens: 11_500,
      input_tokens_details: { cached_tokens: 8_000 }
    });

    expect(usage).toMatchObject({
      input_tokens: 2_000,
      output_tokens: 1_500,
      cache_read_input_tokens: 8_000
    });
    const prompt = (usage.input_tokens as number) +
      (usage.cache_read_input_tokens as number) +
      ((usage.cache_creation_input_tokens as number | undefined) ?? 0);
    expect(prompt + (usage.output_tokens as number)).toBe(11_500);
  });

  it("keeps cache writes out of the fresh Anthropic input too", () => {
    expect(openAiUsageToAnthropic({
      input_tokens: 10_000,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 6_000, cache_write_tokens: 3_000 }
    })).toMatchObject({
      input_tokens: 1_000,
      cache_read_input_tokens: 6_000,
      cache_creation_input_tokens: 3_000
    });
  });

  it("never reports a negative fresh input when the upstream counters disagree", () => {
    expect(openAiUsageToAnthropic({
      input_tokens: 100,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 900 }
    })).toMatchObject({
      input_tokens: 0,
      cache_read_input_tokens: 900
    });
  });

  it("adds the additive Anthropic cache counters into the OpenAI input and total", () => {
    const usage = anthropicUsageToResponses({
      input_tokens: 2,
      output_tokens: 389,
      cache_read_input_tokens: 54_498,
      cache_creation_input_tokens: 4_282
    });

    expect(usage).toMatchObject({
      input_tokens: 58_782,
      output_tokens: 389,
      total_tokens: 59_171,
      input_tokens_details: { cached_tokens: 54_498, cache_write_tokens: 4_282 }
    });
  });

  it("round-trips a full Anthropic usage record through the OpenAI shape", () => {
    const original = {
      input_tokens: 2,
      output_tokens: 389,
      cache_read_input_tokens: 54_498,
      cache_creation_input_tokens: 4_282
    };

    expect(openAiUsageToAnthropic(anthropicUsageToResponses(original))).toMatchObject(original);
  });

  it("leaves a cache-free record alone in both directions", () => {
    expect(anthropicUsageToResponses({ input_tokens: 12, output_tokens: 7 })).toMatchObject({
      input_tokens: 12,
      output_tokens: 7,
      total_tokens: 19
    });
    expect(openAiUsageToAnthropic({ input_tokens: 12, output_tokens: 7 })).toEqual({
      input_tokens: 12,
      output_tokens: 7
    });
  });
});
