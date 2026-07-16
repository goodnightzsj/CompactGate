import { describe, expect, it } from "vitest";
import {
  buildModelListUrls,
  extractModelIds
} from "../src/server/upstream-models.js";

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

  it("clears query and hash values from model candidates", () => {
    expect(buildModelListUrls("https://api.example.com/v1/?tenant=a#section").map((url) => url.toString()))
      .toEqual([
        "https://api.example.com/v1/models",
        "https://api.example.com/models"
      ]);
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
