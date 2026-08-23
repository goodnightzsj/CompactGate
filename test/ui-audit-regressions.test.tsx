import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodexProtocolStatus } from "../src/ui/routes/CodexProtocolStatus.js";
import { ConfigSaveAsNewProfileDialog } from "../src/ui/config/ConfigSaveAsNewProfileDialog.js";
import { nextProfileNameSyncState } from "../src/ui/hooks/useScopedProfileControls.js";
import { saveLabel } from "../src/ui/config/save-state.js";

describe("a failed profile write is visible from wherever it was started", () => {
  it("shows the scope's write error inside the dialog that started it", () => {
    // The only renderer used to be inside ProfileScopeCard, mounted solely on the
    // 档案 tab — while 另存为新档案 and the delete dialog are reachable from every
    // tab. A rejected write there produced no message at all: the dialog simply
    // re-enabled its button and stayed open.
    const markup = renderToStaticMarkup(
      <ConfigSaveAsNewProfileDialog
        config={null}
        profileErrors={{ codex: "Profile name already exists.", claude: null }}
        onCancel={() => undefined}
        onConfirm={() => Promise.resolve(true)}
      />
    );

    expect(markup).toContain("Profile name already exists.");
  });
});

describe("the status line and the save button cannot contradict each other", () => {
  it("reports pending changes rather than a stale failure", () => {
    // saveButtonLabel has no error branch, so after a failed save it already reads
    // "保存到当前档案并应用" while the status line still said 保存失败.
    expect(saveLabel("error", true)).toBe("有未保存更改");
    expect(saveLabel("error", false)).toBe("保存失败");
  });
});

describe("the routes page protocol chip reaches its CSS", () => {
  it("uses hyphenated class names for the underscored protocol values", () => {
    for (const [observed, expected] of [
      ["remote_v1", "remote-v1"],
      ["remote_v2", "remote-v2"],
      ["local", "local"]
    ] as const) {
      const markup = renderToStaticMarkup(
        <CodexProtocolStatus
          status={{
            observed_protocol: observed,
            protocol_source: "request",
            observed_clients: [],
            local_client: null
          } as never}
        />
      );
      // `remote_v1` was passed through raw, so `.protocol-chip.remote-v1` never
      // matched and the chip rendered as unstyled bold text — the same class of
      // defect as the double-prefixed is-is-ok filter tones.
      expect(markup, observed).toContain(`protocol-chip ${expected}`);
      expect(markup, observed).not.toContain("protocol-chip remote_");
    }
  });
});

describe("an in-progress rename survives an action that renames nothing", () => {
  it("keeps a dirty draft whose profile is still the selected one", () => {
    const profiles = [
      { id: "a", name: "Prod" },
      { id: "b", name: "Dev" }
    ] as never as Array<{ id: string; name: string }>;

    // Reorder and apply both used to call setName, which resets the draft, so a
    // half-typed rename vanished when the operator dragged a row.
    expect(nextProfileNameSyncState({
      profiles,
      activeProfileId: "a",
      selectedId: "a",
      name: "Prod v2",
      sourceProfileId: "a",
      dirty: true
    })).toMatchObject({ name: "Prod v2", dirty: true });

    // A draft that belonged to a different profile is still dropped on selection
    // change — it was never about this profile.
    expect(nextProfileNameSyncState({
      profiles,
      activeProfileId: "a",
      selectedId: "b",
      name: "Prod v2",
      sourceProfileId: "a",
      dirty: true
    })).toMatchObject({ name: "Dev", dirty: false });
  });
});
