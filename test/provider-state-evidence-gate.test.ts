import { describe, expect, it } from "vitest";
import type { BufferedUpstreamResult } from "../src/server/upstream-client.js";
import { isEligibleGenericProviderStateFailure } from "../src/server/provider-state-evidence.js";

function upstreamFailure(status: number, message: string, extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({ error: { message, ...extra } });
  return {
    status,
    responseBody: Buffer.from(body),
    responseBodyTruncated: false,
    errorSummary: message
  } as unknown as BufferedUpstreamResult;
}

describe("the generic recovery gate excludes the resource, not the conversation", () => {
  // A request always names a model and relays routinely echo it back, so a
  // bag-of-words match over `errorSummary + whole body` read every one of these as
  // "the model is unavailable" and refused to start recovery — the request then
  // died with the raw upstream error, with no CPA and no strict retry.
  it("still recovers when the error merely mentions the model", () => {
    for (const failure of [
      upstreamFailure(502, "Upstream request failed"),
      upstreamFailure(422, "Invalid 'input[59].encrypted_content'"),
      upstreamFailure(400, "Invalid 'input[59].encrypted_content' for model gpt-5.6-sol", {
        type: "invalid_request_error"
      }),
      upstreamFailure(502, "bad gateway while calling model gpt-5.6-sol; upstream unavailable"),
      upstreamFailure(400, "unknown parameter reasoning.encrypted_content (model gpt-5.6-sol)")
    ]) {
      expect(isEligibleGenericProviderStateFailure(failure), failure.errorSummary ?? "").toBe(true);
    }
  });

  it("still refuses when the model or endpoint itself is what is missing", () => {
    for (const failure of [
      upstreamFailure(400, "The model 'gpt-9' does not exist", { code: "model_not_found" }),
      // The identifier may contain dots, because model ids do.
      upstreamFailure(400, "The model gpt-4.1 does not exist"),
      upstreamFailure(400, "unsupported model for this endpoint"),
      upstreamFailure(400, "endpoint not found")
    ]) {
      expect(isEligibleGenericProviderStateFailure(failure), failure.errorSummary ?? "").toBe(false);
    }
  });
});
