import { describe, expect, it } from "vitest";
import {
  emptyForm,
  formToPatch
} from "../src/ui/config/config-form-state.js";

describe("UI config form state", () => {
  it("serializes the primary failover auto scheduling switch", () => {
    const form = {
      ...emptyForm(),
      autoSchedulePrimaryFailover: false
    };

    expect(formToPatch(form)).toMatchObject({
      primary_failover: {
        auto_schedule: false
      }
    });
  });
});
