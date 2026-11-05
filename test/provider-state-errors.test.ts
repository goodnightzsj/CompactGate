import { gzipSync, brotliCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { classifyProviderStateFailure } from "../src/server/provider-state-errors.js";

const messages = [
  "OpenAI Responses bad request: The encrypted content for item cmp_0bc46799aed69c84016aeb5f812e04819587fdfe6db59f2edc could not be verified. Reason: Encrypted content could not be decrypted or parsed. [trace_id=f6bf77ed00b2590d1bd83d2d2bd2d96a]",
  "OpenAI Responses bad request: The encrypted content gAAA...8A== could not be verified. Reason: Encrypted content could not be decrypted or parsed. [trace_id=8738944f8231fba373c436066de840d4]"
];
const envelope = (message: string, code: unknown = null) => ({ error: { message, type: "invalid_request_error", param: "", code } });
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("provider-state failure classification", () => {
  it.each(messages)("recognizes encrypted-state verification without a stable code: %s", (message) => {
    expect(classifyProviderStateFailure(400, bytes(envelope(message)))).toMatchObject({
      kind: "encrypted_content", code: "invalid_encrypted_content", evidence: "message"
    });
  });

  it.each([null, undefined, 400, "", "invalid_request_error"])("accepts non-specific code %s", (code) => {
    expect(classifyProviderStateFailure(400, bytes(envelope(messages[0], code)))?.kind).toBe("encrypted_content");
  });

  it("resolves complete item IDs but never treats abbreviated ciphertext as an identity", () => {
    const first = classifyProviderStateFailure(400, bytes(envelope(messages[0])));
    expect(first?.itemId).toBe("cmp_0bc46799aed69c84016aeb5f812e04819587fdfe6db59f2edc");
    const second = classifyProviderStateFailure(400, bytes(envelope(messages[1])));
    expect(second?.itemId).toBeNull();
    expect(second?.encryptedContentHash).toBeNull();
  });

  it.each(["gZip", "br"])("uses the response content encoding: %s", (encoding) => {
    const body = bytes(envelope(messages[0]));
    const compressed = encoding === "br" ? brotliCompressSync(body) : gzipSync(body);
    expect(classifyProviderStateFailure(400, compressed, { "content-encoding": encoding })?.kind).toBe("encrypted_content");
  });

  it("unwraps the observed Go numeric-code envelope exactly once", () => {
    const wrapped = envelope(`failed to decode error response: json: cannot unmarshal number into Go struct field APIError.code of type string, raw: ${JSON.stringify(envelope(messages[1], 400))}`);
    expect(classifyProviderStateFailure(400, bytes(wrapped))?.kind).toBe("encrypted_content");
    const twice = envelope(`failed to decode error response: json: cannot unmarshal number into Go struct field APIError.code of type string, raw: ${JSON.stringify(wrapped)}`);
    expect(classifyProviderStateFailure(400, bytes(twice))).toBeNull();
  });

  it.each([
    "The encrypted content could be verified.",
    "The encrypted content was not rejected.",
    "The user wrote: The encrypted content could not be verified.",
    "Invalid model; encrypted content could not be verified in the example.",
    "Authentication failed; encrypted content could not be decrypted.",
    "The encrypted content for item cmp_a could not be verified, or perhaps it was fine.",
    "{\"error\":\"The encrypted content could not be verified.\"}"
  ])("does not mistake prose, quoted examples, or unrelated errors for a repair: %s", (message) => {
    expect(classifyProviderStateFailure(400, bytes(envelope(message)))).toBeNull();
  });

  it.each([401, 403, 404, 429, 500, 502])("does not promote HTTP %s to an explicit repair", (status) => {
    expect(classifyProviderStateFailure(status, bytes(envelope(messages[0])))).toBeNull();
  });

  it("preserves stable code precedence and does not modify the error", () => {
    const body = bytes(envelope(messages[0], "previous_response_not_found"));
    const original = Buffer.from(body);
    expect(classifyProviderStateFailure(400, body)?.kind).toBe("continuation");
    expect(body).toEqual(original);
    expect(classifyProviderStateFailure(400, bytes(envelope(messages[0], "invalid_api_key")))).toBeNull();
  });
});
