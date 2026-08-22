import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfigPreviewPanel } from "../src/ui/config/ConfigPreviewPanel.js";
import { isLatestPreviewRequest } from "../src/ui/hooks/useRoutePreviewAction.js";

describe("route preview request ordering", () => {
  it("accepts only the latest preview response", () => {
    expect(isLatestPreviewRequest(2, 2)).toBe(true);
    expect(isLatestPreviewRequest(1, 2)).toBe(false);
  });

  it("shows friendly protocol and translation labels", () => {
    const markup = renderToStaticMarkup(
      createElement(ConfigPreviewPanel, {
        previewPath: "/anthropic/v1/messages",
        previewBody: "{}",
        previewHeaders: "{}",
        preview: {
          route: "claude",
          compaction_mode: null,
          detection_source: "path",
          method: "POST",
          path: "/anthropic/v1/messages",
          upstream_url: "https://openai.example/v1/responses",
          upstream_host: "openai.example",
          ingress_protocol: "anthropic_messages",
          upstream_protocol: "openai_responses",
          translation_mode: "translate",
          source_model: "claude-opus-4-1",
          target_model: "gpt-5.5",
          body_rewritten: true,
          stream_removed: false
        },
        previewError: null,
        onPathChange: () => undefined,
        onBodyChange: () => undefined,
        onHeadersChange: () => undefined,
        onPreviewSubmit: () => undefined,
    onPreviewClear: () => undefined
      })
    );

    expect(markup).toContain("Claude 消息");
    expect(markup).toContain("/anthropic/v1/messages");
    expect(markup).toContain("Anthropic Messages (anthropic_messages)");
    expect(markup).toContain("OpenAI Responses (openai_responses)");
    expect(markup).toContain("协议转换 (translate)");
  });
});
