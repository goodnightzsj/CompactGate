import { describe, expect, it } from "vitest";
import {
  buildModelListUrls,
  extractModelIds
} from "../src/server/upstream-models.js";
import { startApp, startUpstream, writeJsonResponse } from "./helpers/server-test-utils.js";

describe("upstream model discovery", () => {
  it.each([
    [
      "https://api.example.com",
      [
        "https://api.example.com/v1/models",
        "https://api.example.com/models"
      ]
    ],
    [
      "https://api.example.com/v1/",
      [
        "https://api.example.com/v1/models",
        "https://api.example.com/models"
      ]
    ],
    [
      "https://open.bigmodel.cn/api/coding/paas/v4",
      [
        "https://open.bigmodel.cn/api/coding/paas/v4/models",
        "https://open.bigmodel.cn/api/coding/paas/v4/v1/models",
        "https://open.bigmodel.cn/v1/models",
        "https://open.bigmodel.cn/models"
      ]
    ],
    [
      "https://api.deepseek.com/anthropic",
      [
        "https://api.deepseek.com/anthropic/v1/models",
        "https://api.deepseek.com/anthropic/models",
        "https://api.deepseek.com/v1/models",
        "https://api.deepseek.com/models"
      ]
    ],
    [
      "https://api.example.com/tenant/gateway",
      [
        "https://api.example.com/tenant/gateway/v1/models",
        "https://api.example.com/tenant/gateway/models",
        "https://api.example.com/v1/models",
        "https://api.example.com/models"
      ]
    ]
  ])("builds ordered model candidates for %s", (baseUrl, expected) => {
    expect(buildModelListUrls(baseUrl).map((url) => url.toString())).toEqual(expected);
  });

  it("preserves base query parameters on same-origin fallbacks and discards the fragment", () => {
    expect(buildModelListUrls("https://api.example.com/v1/?api-version=1&tag=a&tag=b#section").map((url) => url.toString()))
      .toEqual([
        "https://api.example.com/v1/models?api-version=1&tag=a&tag=b",
        "https://api.example.com/models?api-version=1&tag=a&tag=b"
      ]);
  });

  it("uses the configured query for both Studio model lists and their path fallbacks", async () => {
    const paths: string[] = [];
    const upstream = await startUpstream((req, res) => {
      paths.push(req.url!);
      writeJsonResponse(res, { data: [{ id: "fixture" }] }, req.url === "/v1/models?api-version=test" ? 200 : 404);
    });
    const base_url = new URL("/tenant?api-version=test#section", upstream.url).href;
    const app = await startApp(base_url, undefined, { claude: { primary: { base_url } } });
    const attempts = ["/tenant/v1/models", "/tenant/models", "/v1/models"].map(path => path + "?api-version=test");
    for (const scope of ["openai", "claude"]) {
      const response = await fetch(`${app.url}/api/${scope}/models`);
      expect(await response.json()).toMatchObject({ models: ["fixture"], error: null });
    }
    expect(paths).toEqual([...attempts, ...attempts]);
  });

  it("normalizes common compatible response entries", () => {
    expect(extractModelIds({
      data: [
        { id: " model-z " },
        { name: "model-a" },
        { model: "model-m" },
        "model-a",
        "  ",
        null
      ]
    })).toEqual(["model-a", "model-m", "model-z"]);
  });
});
