import { describe, expect, it } from "vitest";
import { validateImportCandidateShape } from "../src/ui/config/useConfigImportWorkflow.js";

describe("config import logging validation", () => {
  it("accepts nullable capture directories and numeric byte limits", () => {
    expect(() =>
      validateImportCandidateShape({
        logging: {
          redact_body: true,
          persist_body: false,
          keep_recent: 200,
          capture_dir: null,
          capture_body_max_bytes: 1024,
          capture_dir_max_bytes: 2048,
          max_database_bytes: 4096
        }
      })
    ).not.toThrow();
  });

  it.each([
    ["redact_body", "yes"],
    ["capture_dir", 123],
    ["capture_body_max_bytes", "1024"],
    ["capture_dir_max_bytes", "2048"],
    ["max_database_bytes", "4096"]
  ])("rejects an invalid logging.%s type", (field, value) => {
    expect(() =>
      validateImportCandidateShape({
        logging: {
          [field]: value
        }
      })
    ).toThrow(`logging.${field}`);
  });
});
