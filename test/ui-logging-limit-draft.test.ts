import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import {
  applyDraftToConfigExport,
  emptyForm,
  formFromConfig,
  formToPatch
} from "../src/ui/config/config-form-state.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

// An emptied `<input type="number">` reads as `""`, and `Number("")` is 0.
const BLANK = Number("");

describe("a blank logging limit box never reaches the server as a real cap", () => {
  it("omits the limit instead of clamping it to the legal floor", () => {
    const patch = formToPatch({
      ...emptyForm(),
      loggingMaxDatabaseMiB: BLANK,
      loggingCaptureDirMaxGiB: BLANK,
      loggingCaptureBodyMaxMiB: BLANK,
      loggingKeepRecent: BLANK
    });

    // Clamping to the floor sent 1 byte, which passes the server's `> 0` check
    // and makes `RequestLogger.configure` prune the whole log history and capture
    // directory to honour it — while the save bar reports success. Omitting the
    // key means "unchanged", which is what a blank box actually expresses.
    expect(patch.logging.max_database_bytes).toBeUndefined();
    expect(patch.logging.capture_dir_max_bytes).toBeUndefined();
    expect(patch.logging.capture_body_max_bytes).toBeUndefined();
    expect(patch.logging.keep_recent).toBeUndefined();

    // And the omission survives serialization, which is how it reaches the server.
    expect(JSON.parse(JSON.stringify(patch)).logging).not.toHaveProperty("max_database_bytes");
  });

  it("still sends a value the operator actually typed, and caps keep_recent at the advertised max", () => {
    const patch = formToPatch({
      ...emptyForm(),
      loggingMaxDatabaseMiB: 512,
      loggingKeepRecent: 5_000
    });

    expect(patch.logging.max_database_bytes).toBe(512 * 1024 * 1024);
    // The box advertises max="2000" that nothing enforced — the page has no
    // <form>, so HTML5 validation never runs. Rejecting the whole PATCH would
    // have discarded every other edit in the draft along with it.
    expect(patch.logging.keep_recent).toBe(2_000);
  });

  it("exports the saved value rather than a blank box", async () => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    await store.patch({ logging: { keep_recent: 250, max_database_bytes: 777 * 1024 * 1024 } });
    const saved = store.get();

    const exported = applyDraftToConfigExport(saved, {
      ...formFromConfig(store.toPublicConfig()),
      loggingKeepRecent: BLANK,
      loggingMaxDatabaseMiB: BLANK
    });

    // An export is a complete config, so it cannot omit the field — and writing
    // the blank box through as 0 produced a file CompactGate's own import rejects.
    expect(exported.logging.keep_recent).toBe(250);
    expect(exported.logging.max_database_bytes).toBe(777 * 1024 * 1024);
    await expect(store.importConfig(exported)).resolves.toBeTruthy();
  });
});
