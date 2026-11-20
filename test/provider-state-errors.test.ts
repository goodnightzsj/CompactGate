import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { classifyProviderStateFailure } from "../src/server/provider-state-errors.js";

const messages = [
  "OpenAI Responses bad request: The encrypted content for item cmp_0bc46799aed69c84016aeb5f812e04819587fdfe6db59f2edc could not be verified. Reason: Encrypted content could not be decrypted or parsed. [trace_id=f6bf77ed00b2590d1bd83d2d2bd2d96a]",
  "OpenAI Responses bad request: The encrypted content gAAA...8A== could not be verified. Reason: Encrypted content could not be decrypted or parsed. [trace_id=8738944f8231fba373c436066de840d4]",
  "The encrypted content gAAA...NZs= could not be verified. Reason: Encrypted content could not be decrypted or parsed. (request id: 20261118172142279851059wOjRhakM) [trace_id=219be03eb78413375f7dc7d79852d3db]",
  "OpenAI Responses bad request: The encrypted content for item cmp_hub_regression could not be verified. Reason: Encrypted content could not be decrypted or parsed. [hub-] [trace_id=377e5462fd806973bb72b4266f9faac5]"
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

  it.each(["request_123-X", "a".repeat(128)])("accepts a bounded request ID without a trace: %s", requestId => {
    const message = `The encrypted content for item cmp_a could not be verified. (request id: ${requestId})`;
    expect(classifyProviderStateFailure(400, bytes(envelope(message)))).toMatchObject({
      itemId: "cmp_a", kind: "encrypted_content", evidence: "message"
    });
  });

  it("preserves the complete ciphertext locator and original error bytes with request diagnostics", () => {
    const content = "gAAA_synthetic_NZs=";
    const body = bytes(envelope(messages[2].replace("gAAA...NZs=", content)));
    const original = Buffer.from(body);
    expect(classifyProviderStateFailure(400, body)).toMatchObject({
      encryptedContentHash: createHash("sha256").update(content).digest("hex"), evidence: "message"
    });
    expect(body).toEqual(original);
  });

  it("separates unseen diagnostic combinations from failure semantics and targeting", () => {
    const prefixes = ["", "OpenAI Responses bad request: ", "Gateway error: OpenAI Responses bad request: ",
      "[edge=front-2] OpenAI Responses bad request: [proxy-v3] "];
    const tails = ["", " [hub-]", " [trace-id: synthetic/segment] [gateway-v2]",
      " [trace_id=synthetic] (request id: req_123-X)", " (node id: east-1) [request_id=req_123] [hub-]",
      " [region=ap-south-9] (Trace ID: trace_1)"];
    for (const prefix of prefixes) for (const tail of tails) {
      for (const predicate of ["could not be verified", "cannot be decrypted or parsed", "can't be parsed", "couldn't be verified"]) {
        for (const punctuation of [".", "!", ""]) {
          const message = `${prefix}The encrypted content for item cmp_variant ${predicate}${punctuation}${tail}`;
          for (const variant of [message, message.toUpperCase().replaceAll(" ", "\n\t")]) {
            for (const code of [null, "invalid_encrypted_content"]) {
              const body = bytes(envelope(variant, code));
              const original = Buffer.from(body);
              expect(classifyProviderStateFailure(400, body), variant).toMatchObject({
                code: "invalid_encrypted_content", itemId: variant.includes("CMP_VARIANT") ? "CMP_VARIANT" : "cmp_variant",
                encryptedContentHash: null, evidence: code ? "code" : "message"
              });
              expect(body).toEqual(original);
            }
          }
        }
      }
    }
  });

  it("keeps full ciphertext hashes after mixed diagnostic wrappers", () => {
    const content = "gAAA_synthetic_NZs=";
    const message = `[edge-v2] Gateway error: Encrypted content ${content} cannot be verified! Cause: encrypted content can't be decrypted or parsed [trace_id=synthetic] (request id: request123) [hub-]`;
    for (const code of [null, "invalid_encrypted_content"]) {
      expect(classifyProviderStateFailure(400, bytes(envelope(message, code)))).toMatchObject({
        itemId: null, encryptedContentHash: createHash("sha256").update(content).digest("hex")
      });
    }
  });

  it("limits diagnostic wrappers and message size before treating prose as evidence", () => {
    const message = "The encrypted content could not be verified.";
    const tags = Array.from({ length: 9 }, (_, index) => `[node-${index}=shard]`);
    expect(classifyProviderStateFailure(400, bytes(envelope(`${message} ${tags.slice(0, 8).join(" ")}`)))?.kind).toBe("encrypted_content");
    expect(classifyProviderStateFailure(400, bytes(envelope(`${message} ${tags.join(" ")}`)))).toBeNull();
    expect(classifyProviderStateFailure(400, bytes(envelope(`${" ".repeat(65_536)}${message}`)))).toBeNull();
    expect(classifyProviderStateFailure(400, bytes(envelope(`${"Gateway error: ".repeat(9)}${message}`)))).toBeNull();
  });

  it.each([
    "(request id: )",
    "(request id: bad id)",
    "(request id: request/123)",
    `(request id: ${"a".repeat(129)})`,
    "(request id: request123) unexpected text",
    "(request id: request123) (request id: request456)",
    "[request_id=request123] (Request ID: request456)",
    "[trace_id=synthetic] [trace-id=other]",
    "[hub-] trailing explanation",
    "[hub-] [not a diagnostic]",
    "[hub-] [trace_id=]",
    "[hub-] [nested=[trace_id=synthetic]]",
    "[hub-] [trace_id=unterminated",
    `[${"a".repeat(65)}]`,
    `[trace_id=${"a".repeat(129)}]`,
    "[hub-] (request id: req123) quoted example"
  ])("rejects malformed or unrecognized diagnostic tails: %s", suffix => {
    expect(classifyProviderStateFailure(400, bytes(envelope(`The encrypted content could not be verified. ${suffix}`)))).toBeNull();
  });

  it.each(["gZip", "br"])("uses the response content encoding: %s", (encoding) => {
    for (const message of messages) {
      const body = bytes(envelope(message));
      const compressed = encoding === "br" ? brotliCompressSync(body) : gzipSync(body);
      expect(classifyProviderStateFailure(400, compressed, { "content-encoding": encoding })?.kind).toBe("encrypted_content");
    }
  });

  it.each([messages[1], messages[2], messages[3]])("unwraps the observed Go numeric-code envelope exactly once: %s", message => {
    const wrapped = envelope(`failed to decode error response: json: cannot unmarshal number into Go struct field APIError.code of type string, raw: ${JSON.stringify(envelope(message, 400))}`);
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
    "[hub-] The user wrote: The encrypted content could not be verified. [trace_id=synthetic]",
    "[hub-] The encrypted content could not be verified. This is only an example. [trace_id=synthetic]",
    "[hub-] The encrypted content could not be verified. Reason: encrypted content could be verified.",
    "[hub-] The encrypted content could not be verified? [trace_id=synthetic]",
    "[hub-] The encrypted content was not rejected. [trace_id=synthetic]",
    "[hub-] Gateway error: \"The encrypted content could not be verified.\" [trace_id=synthetic]",
    "{\"error\":\"The encrypted content could not be verified.\"}"
  ])("does not mistake prose, quoted examples, or unrelated errors for a repair: %s", (message) => {
    expect(classifyProviderStateFailure(400, bytes(envelope(message)))).toBeNull();
  });

  it.each([401, 403, 404, 429, 500, 502])("does not promote HTTP %s to an explicit repair", (status) => {
    expect(classifyProviderStateFailure(status, bytes(envelope(messages[0])))).toBeNull();
  });

  it.each(messages)("preserves stable code precedence and does not modify the error: %s", message => {
    const body = bytes(envelope(message, "previous_response_not_found"));
    const original = Buffer.from(body);
    expect(classifyProviderStateFailure(400, body)?.kind).toBe("continuation");
    expect(body).toEqual(original);
    expect(classifyProviderStateFailure(400, bytes(envelope(message, "invalid_api_key")))).toBeNull();
  });
});
