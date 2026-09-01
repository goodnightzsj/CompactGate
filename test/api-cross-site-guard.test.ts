import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { crossSiteApiRejection } from "../src/server/http.js";

// The admin API carries no credential, and `readJsonBody` ignores Content-Type,
// so a `text/plain` POST from any page is a CORS simple request: no preflight,
// and the write lands whether or not the page can read the reply. These headers
// are the only signal separating that page from the operator's own tools.
function request(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("admin API cross-site guard", () => {
  it("allows the Studio page and CLI callers", () => {
    // Studio, served from the gateway itself.
    expect(crossSiteApiRejection(request({
      origin: "http://127.0.0.1:7865",
      host: "127.0.0.1:7865"
    }))).toBeNull();
    // curl, the e2e script, the agent launchers: no Origin at all.
    expect(crossSiteApiRejection(request({ host: "127.0.0.1:7865" }))).toBeNull();
    // Loopback spellings the operator may actually use.
    for (const host of ["localhost:7865", "[::1]:7865", "127.0.0.2:7865", "localhost"]) {
      expect(crossSiteApiRejection(request({ host }))).toBeNull();
    }
  });

  it("refuses a page driving the API from another site", () => {
    expect(crossSiteApiRejection(request({
      origin: "https://evil.example",
      host: "127.0.0.1:7865"
    }))).toMatch(/cross-site Origin/);
    // A loopback *port* other than ours is still another origin to the browser,
    // but it is still this machine, so it stays allowed rather than half-blocked.
    expect(crossSiteApiRejection(request({
      origin: "http://127.0.0.1:3000",
      host: "127.0.0.1:7865"
    }))).toBeNull();
  });

  it("refuses DNS rebinding, where a hostile name resolves to loopback", () => {
    expect(crossSiteApiRejection(request({ host: "rebind.evil.example:7865" })))
      .toMatch(/Host refused/);
    // Rebinding usually pairs a same-looking Origin with the hostile Host.
    expect(crossSiteApiRejection(request({
      origin: "http://rebind.evil.example:7865",
      host: "rebind.evil.example:7865"
    }))).toMatch(/cross-site Origin/);
  });

  it("refuses an Origin it cannot parse instead of waving it through", () => {
    expect(crossSiteApiRejection(request({ origin: "not a url", host: "127.0.0.1:7865" })))
      .toMatch(/unparsable Origin/);
    // A sandboxed iframe sends the literal "null"; treat it as no Origin, since
    // it carries no host to compare and blocking it would break nothing today.
    expect(crossSiteApiRejection(request({ origin: "null", host: "127.0.0.1:7865" })))
      .toBeNull();
  });
});
