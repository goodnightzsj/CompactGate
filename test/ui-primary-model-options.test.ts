import { describe, expect, it } from "vitest";
import {
  primaryModelOptions,
  primaryReasoningOptions
} from "../src/ui/config/primary-model-options.js";

describe("Primary model options", () => {
  it("builds sorted model options from the active upstream response", () => {
    expect(primaryModelOptions(
      ["gpt-compatible-z", "gpt-compatible-a", "gpt-compatible-a"],
      "gpt-compatible-a"
    )).toEqual([
      {
        value: "",
        label: "跟随请求",
        meta: "不覆盖客户端传入的 model"
      },
      {
        value: "gpt-compatible-a",
        label: "gpt-compatible-a",
        meta: "来自当前 Primary 上游"
      },
      {
        value: "gpt-compatible-z",
        label: "gpt-compatible-z",
        meta: "来自当前 Primary 上游"
      }
    ]);
  });

  it("keeps the configured custom model available after fetching", () => {
    expect(primaryModelOptions(["gpt-upstream"], "custom-model")).toContainEqual({
      value: "custom-model",
      label: "custom-model",
      meta: "当前自定义值"
    });
  });

  it("does not offer none as a normal reasoning selection", () => {
    expect(primaryReasoningOptions().map((option) => option.value)).toEqual([
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]);
  });

  it("never exposes none through the Studio select", () => {
    expect(primaryReasoningOptions()).not.toContainEqual(expect.objectContaining({
      value: "none"
    }));
  });
});
