// @vitest-environment jsdom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { useProfileDragReorder } from "../src/ui/config/useProfileDragReorder.js";
import { createConfigProfileCollectionActions } from "../src/ui/hooks/configProfileCollectionActions.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

afterEach(() => vi.unstubAllGlobals());

it("pins a reorder to the revision visible when dragging started, even after a Studio snapshot", async () => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  await store.saveProfile("codex", "A", {});
  await store.saveProfile("codex", "B", {});
  const config = store.toPublicConfig();
  const [a, b] = config.profiles.map(profile => profile.id);
  const send = vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve(Response.json({ error: "superseded revision" }, { status: 409 })));
  vi.stubGlobal("fetch", send);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onConfigChange = vi.fn();
  const controls = { selectedId: a, name: "A", selectionRevision: 0, interactionRevision: 0, state: "idle" as const, setState: vi.fn(),
    setSelectedId: vi.fn(), setName: vi.fn(), commitSavedName: vi.fn(), setError: vi.fn() };
  function Harness({ revision }: { revision: string }) {
    const actions = createConfigProfileCollectionActions({ config: { ...config, revision }, onConfigChange,
      profileDeleteCandidate: null, setProfileDeleteCandidate: vi.fn(), scopedProfileAccessors: () => controls });
    const drag = useProfileDragReorder({ profiles: config.profiles, canReorderProfiles: true,
      onReorderProfiles: ids => actions.reorderProfiles("codex", ids) });
    return <div onDragStart={event => drag.handleProfileDragStart(event, b)}
      onDrop={event => drag.handleProfileDrop(event, a)} />;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  const dataTransfer = { setData: vi.fn() };
  const dispatch = (event: string) => act(async () => host.firstElementChild!.dispatchEvent(
    Object.assign(new MouseEvent(event, { bubbles: true }), { dataTransfer })));
  try {
    await act(async () => root.render(<Harness revision={config.revision} />));
    await dispatch("dragstart");
    await act(async () => root.render(<Harness revision="later" />));
    await dispatch("drop");
    expect(JSON.parse(String(send.mock.calls[0][1].body))).toEqual({ scope: "codex", profile_ids: [b, a], revision: config.revision });
    expect(controls.setError).toHaveBeenLastCalledWith(expect.stringContaining("重新排序"));
    expect(onConfigChange).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
