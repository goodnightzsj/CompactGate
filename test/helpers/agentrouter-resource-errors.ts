const resourceMessage = "The requested item was created under a different Azure OpenAI resource. " +
  "Use the same resource that created the item to access it.";
const response = (message: string) => ({ error: {
  message, type: "invalid_request_error", param: "", code: null
} });
const goWrapped = (message: string) => response(
  "failed to decode error response: json: cannot unmarshal number into Go struct field " +
  "gateway.Error.code of type string, raw: " +
  JSON.stringify({ error: { ...response(message).error, code: 0 } }) +
  `\n[trace_id=${"b".repeat(32)}]`
);

// Shared across classifier, coordinator, and real loopback HTTP/SSE regressions.
export const agentrouterResourceErrorCases = [
  { name: "direct", response: response(resourceMessage) },
  { name: "Go-wrapped", response: goWrapped(resourceMessage) },
  { name: "Responses-prefixed", response: response(`OpenAI Responses bad request: ${resourceMessage}`) },
  { name: "observed masked resource", response: response(
    `OpenAI Responses bad request: ${resourceMessage.replace("Azure", "***")} ` +
    "[trace_id=2a4a42762771b1b5782e6770af578193]"
  ) },
  { name: "variable masking", response: response(resourceMessage.replace("Azure", "********")) },
  { name: "renamed multiword vendor", response: response(resourceMessage.replace("Azure", "Vendor-42 Europe")) },
  { name: "vendorless resource", response: response(resourceMessage.replace("Azure ", "")) },
  { name: "case and whitespace", response: response(
    ` \nOpenAI\tResponses BAD REQUEST :\r\n${resourceMessage.toUpperCase().replaceAll(" ", "\t \n")} \n`
  ) },
  { name: "Responses error label", response: response(
    `Relay-X Responses error: ${resourceMessage.replace("Azure", "[REDACTED]")}`
  ) },
  { name: "gateway error label", response: response(`Upstream gateway error: ${resourceMessage}`) },
  { name: "HTTP bad-request label", response: response(`HTTP 400 Bad Request: ${resourceMessage}`) },
  { name: "Go-wrapped semantic variant", response: goWrapped(
    `Responses error: ${resourceMessage.replace("Azure", "[hidden]").replaceAll(" ", "\n")}`
  ) }
];
