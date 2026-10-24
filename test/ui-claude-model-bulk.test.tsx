// @vitest-environment jsdom
import path from "node:path";
import { act, StrictMode, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import type { ClaudeModelMapRole, PublicConfig } from "../src/shared/types.js";
import { ConfigModelPanel } from "../src/ui/config/ConfigModelPanel.js";
import { emptyForm, formToPatch } from "../src/ui/config/config-form-state.js";
import { CLAUDE_MODEL_MAP_ROLES } from "../src/ui/config/model-map.js";
import { INITIAL_STUDIO_CONFIG_STATE, reduceStudioConfigState } from "../src/ui/config/studio-config-state.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

const originalMap = { default: "old-default", opus: "old-opus", sonnet: "old-sonnet",
  haiku: "old-haiku", reasoning: "old-reasoning", subagent: "old-subagent" };
const catalogue = { models: ["model-a", "model-b"], upstream_host: "synthetic.example", error: null };
let config: PublicConfig;
let root: Root;
let container: HTMLDivElement;

function Harness({ source }: { source: PublicConfig }) {
  const [state, dispatch] = useReducer(reduceStudioConfigState, {
    ...INITIAL_STUDIO_CONFIG_STATE,
    form: { ...emptyForm(), claudeModelMap: originalMap, primaryModelOverride: "codex-keep" }
  });
  return <>
    <ConfigModelPanel config={source} form={state.form} scope="claude" linkedCompactModel="unused"
      onFormChange={(value) => dispatch({ type: "set_form", value })}
      onUnlockCompactModel={() => undefined} onRestoreLinkedMode={() => undefined} />
    <button onClick={() => dispatch({ type: "set_form", value: (form) => ({ ...form, loggingKeepRecent: 777 }) })}>
      unrelated draft
    </button>
    <output>{JSON.stringify(state)}</output>
  </>;
}

beforeEach(async () => {
  config = (await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"))).toPublicConfig();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    expect(url).toBe("/api/claude/models");
    return Response.json(catalogue);
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render(config);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(source: PublicConfig) {
  await act(async () => root.render(<StrictMode><Harness source={source} /></StrictMode>));
}

function button(text: string) {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  expect(found, text).toBeDefined();
  return found!;
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
  await act(async () => vi.advanceTimersByTime(20));
}

function input(role: ClaudeModelMapRole) {
  return container.querySelectorAll<HTMLInputElement>(".claude-model-map-row input")[CLAUDE_MODEL_MAP_ROLES.indexOf(role)];
}

async function choose(role: ClaudeModelMapRole, model: string) {
  await click(input(role).closest(".claude-model-map-row")!.querySelector<HTMLButtonElement>("[aria-haspopup=listbox]")!);
  const option = [...document.querySelectorAll<HTMLButtonElement>("[role=option]")]
    .find((item) => item.querySelector("strong")?.textContent === model);
  expect(option).toBeDefined();
  await click(option!);
}

async function typeModel(role: ClaudeModelMapRole, value: string) {
  await act(async () => {
    const target = input(role);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function state() { return JSON.parse(container.querySelector("output")!.textContent!); }
function offer() { return container.querySelector(".model-bulk-offer"); }

describe("Claude catalogue bulk selection", () => {
  it("keeps manual edits and fetched catalogues from changing other slots", async () => {
    await typeModel("sonnet", "manual-model");
    expect(offer()).toBeNull();
    await click(button("拉取模型"));
    expect(state().form.claudeModelMap).toEqual({ ...originalMap, sonnet: "manual-model" });
    expect(offer()).toBeNull();
    await choose("sonnet", "手动输入");
    expect(offer()).toBeNull();
  });

  it("changes one slot first, then atomically applies all six while retaining newer unrelated edits", async () => {
    await click(button("拉取模型"));
    await choose("subagent", "model-a");
    expect(state().form.claudeModelMap).toEqual({ ...originalMap, subagent: "model-a" });
    expect(offer()?.querySelectorAll("li")).toHaveLength(6);
    expect(offer()?.textContent).toContain("保存配置后生效");
    await click(button("unrelated draft"));
    await click(button("应用到全部 6 个槽位"));
    const current = state();
    expect(Object.values(current.form.claudeModelMap)).toEqual(Array(6).fill("model-a"));
    expect(current.form).toMatchObject({ primaryModelOverride: "codex-keep", loggingKeepRecent: 777 });
    expect(current.draftRevision).toBe(3);
    expect(formToPatch(current.form).claude.model_map).toEqual(current.form.claudeModelMap);
    expect(formToPatch(current.form).claude.primary.model_override).toBe("model-a");
    expect(offer()).toBeNull();
    expect(container.textContent).toContain("已填入全部 6 个槽位");
    expect(document.activeElement).toBe(input("subagent"));
    expect(fetch).toHaveBeenCalledTimes(1);
    await typeModel("haiku", "custom-haiku");
    expect(state().form.claudeModelMap.haiku).toBe("custom-haiku");
    expect(container.textContent).not.toContain("已填入全部 6 个槽位");
  });

  it("offers once per successful fetch, preserving the first choice when declined", async () => {
    await click(button("拉取模型"));
    await choose("opus", "model-a");
    await click(button("仅此槽位"));
    expect(state().form.claudeModelMap).toEqual({ ...originalMap, opus: "model-a" });
    expect(document.activeElement).toBe(input("opus"));
    await choose("haiku", "model-b");
    expect(offer()).toBeNull();
    await click(button("拉取模型"));
    await choose("haiku", "model-a");
    expect(offer()).not.toBeNull();
  });

  it.each(["manual", "catalogue"])("dismisses the old offer when another %s edit follows", async (kind) => {
    await click(button("拉取模型"));
    await choose("default", "model-a");
    if (kind === "manual") await typeModel("reasoning", "manual-reasoning");
    else await choose("sonnet", "model-b");
    expect(offer()).toBeNull();
    expect(state().form.claudeModelMap.default).toBe("model-a");
    await choose("opus", "model-b");
    expect(offer()).toBeNull();
  });

  it("does not revive a pending offer across source A -> B -> A", async () => {
    await click(button("拉取模型"));
    await choose("default", "model-a");
    const next = structuredClone(config);
    next.claude.primary.model_source_revision = "new-connection";
    await render(next);
    expect(offer()).toBeNull();
    await render(config);
    expect(offer()).toBeNull();
    expect(container.querySelector("[aria-haspopup=listbox]")).toBeNull();
    expect(state().form.claudeModelMap.default).toBe("model-a");
    await click(button("拉取模型"));
    await choose("default", "model-b");
    expect(offer()?.textContent).toContain("model-b");
  });

  it("hides a stale offer during refetch and on failure without resetting drafts", async () => {
    await click(button("拉取模型"));
    await choose("default", "model-a");
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await click(button("拉取模型"));
    expect(offer()).toBeNull();
    await act(async () => resolve(Response.json({ ...catalogue, models: [], error: "synthetic failure" })));
    expect(offer()).toBeNull();
    expect(state().form.claudeModelMap).toEqual({ ...originalMap, default: "model-a" });
    expect(container.textContent).toContain("synthetic failure");
  });

  it("dismisses with Escape and returns focus without applying other slots", async () => {
    await click(button("拉取模型"));
    await choose("reasoning", "model-b");
    const apply = button("应用到全部 6 个槽位");
    await act(async () => {
      apply.focus();
      apply.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(offer()).toBeNull();
    expect(document.activeElement).toBe(input("reasoning"));
    expect(state().form.claudeModelMap).toEqual({ ...originalMap, reasoning: "model-b" });
  });
});
