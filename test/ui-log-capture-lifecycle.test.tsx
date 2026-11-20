// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import * as captureDiff from "../src/shared/capture-diff.js";
import type { RequestLogEntry } from "../src/shared/types.js";
import { LogCaptureViewer } from "../src/ui/logs/LogCaptureViewer.js";

async function mountViewer() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const show = (id: string, bodyStatus: RequestLogEntry["body_status"] = "present") => act(async () => root.render(<LogCaptureViewer
    entry={{ request_id: id, capture_status: "present", body_status: bodyStatus }} />));
  await show("first");
  return { host, show, load: () => act(async () => host.querySelector("button")!.click()),
    close: () => act(async () => root.unmount()) };
}

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("navigates all capture tabs by keyboard with one tab stop and a labelled panel", async () => {
  const stage = { headers: {}, body: { byte_length: 2, captured_byte_length: 2, truncated: false, text: "{}" } };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ incoming_request: stage, upstream_request: stage,
    upstream_response: { ...stage, status: 200 }, client_response: null })));
  const view = await mountViewer();
  try {
    await view.load();
    const tabs = [...view.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs).toHaveLength(6);
    tabs[0].focus();
    const check = (index: number) => {
      const panel = view.host.querySelector('[role="tabpanel"]')!;
      expect(view.host.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
      expect(document.activeElement).toBe(tabs[index]);
      expect(tabs[index].getAttribute("aria-selected")).toBe("true");
      expect(tabs[index].tabIndex).toBe(0);
      expect(tabs[index].getAttribute("aria-controls")).toBe(panel.id);
      expect(panel.getAttribute("aria-labelledby")).toBe(tabs[index].id);
    };
    check(0);
    for (const [key, index] of [["ArrowLeft", 5], ["ArrowRight", 0], ["End", 5], ["Home", 0],
      ["ArrowRight", 1], ["ArrowRight", 2], ["ArrowRight", 3], ["ArrowRight", 4]] as const) {
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
      check(index);
    }
  } finally { await view.close(); }
});

it("cancels a capture on entry change and unmount and skips late response decoding", async () => {
  const pending: { signal: AbortSignal; finish: (response: Response) => void }[] = [];
  vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise<Response>(finish => {
    pending.push({ signal: init.signal as AbortSignal, finish });
  })));
  const view = await mountViewer();
  await view.load();
  await view.show("second");
  expect(pending[0].signal.aborted).toBe(true);
  expect(view.host.textContent).toContain("查看抓包");
  await view.load();
  const stale = Response.json({}); const decode = vi.spyOn(stale, "json");
  await act(async () => pending[0].finish(stale));
  expect(decode).not.toHaveBeenCalled();
  expect(view.host.textContent).toContain("正在读取抓包");
  await view.close();
  expect(pending[1].signal.aborted).toBe(true);
  const late = Response.json({}); const lateDecode = vi.spyOn(late, "json");
  await act(async () => pending[1].finish(late));
  expect(lateDecode).not.toHaveBeenCalled();
});

it.each([false, true])("keeps loading focus and respects a move outside the capture, moved=%s", async moved => {
  let finish!: (response: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetchMock);
  const view = await mountViewer();
  const outside = document.createElement("input");
  document.body.append(outside);
  try {
    const trigger = view.host.querySelector<HTMLButtonElement>("button")!;
    trigger.focus();
    await view.load();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    await act(async () => trigger.click());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (moved) outside.focus();
    const stage = { headers: {}, body: { byte_length: 2, captured_byte_length: 2, truncated: false, text: "{}" } };
    await act(async () => finish(Response.json({ incoming_request: stage, upstream_request: stage,
      upstream_response: { ...stage, status: 200 }, client_response: null })));
    expect(document.activeElement).toBe(moved ? outside : view.host.querySelector('[role="tab"]'));
  } finally { await view.close(); }
});

it.each([202, 404, 410, 503])("keeps a keyboard destination after capture returns %s", async status => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Synthetic capture status" }, { status })));
  const view = await mountViewer();
  try {
    view.host.querySelector<HTMLButtonElement>("button")!.focus();
    await view.load();
    const destination = view.host.querySelector("button") ?? view.host.querySelector("section");
    expect(document.activeElement).toBe(destination);
  } finally { await view.close(); }
});

it("reuses the active diff on metadata updates and recomputes for a new capture", async () => {
  const requestDiff = vi.spyOn(captureDiff, "captureRequestDiff");
  const responseDiff = vi.spyOn(captureDiff, "captureResponseDiff");
  const stage = (model: string) => {
    const text = JSON.stringify({ model });
    return { headers: {}, body: { byte_length: text.length, captured_byte_length: text.length, truncated: false, text } };
  };
  const record = (id: string) => ({ incoming_request: stage(`${id}_before`), upstream_request: stage(`${id}_after`),
    upstream_response: { ...stage(`${id}_before`), status: 200 }, client_response: { ...stage(`${id}_after`), status: 200 } });
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json(record("first")))
    .mockResolvedValueOnce(Response.json(record("second"))));
  const view = await mountViewer();
  const selectDiff = (index: number) => act(async () => view.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index].click());
  try {
    await view.load();
    expect(requestDiff).not.toHaveBeenCalled();
    expect(responseDiff).not.toHaveBeenCalled();
    await selectDiff(4);
    expect(requestDiff).toHaveBeenCalledTimes(1);
    expect(view.host.querySelector('[role="tabpanel"]')!.textContent).toContain("first_after");
    await view.show("first", "purged");
    expect(view.host.textContent).toContain("SQLite 已清理");
    expect(requestDiff).toHaveBeenCalledTimes(1);
    await selectDiff(5);
    expect(responseDiff).toHaveBeenCalledTimes(1);
    await view.show("first");
    expect(responseDiff).toHaveBeenCalledTimes(1);
    await view.show("second");
    await view.load();
    expect(requestDiff).toHaveBeenCalledTimes(1);
    expect(responseDiff).toHaveBeenCalledTimes(1);
    await selectDiff(4);
    expect(requestDiff).toHaveBeenCalledTimes(2);
    await selectDiff(5);
    expect(responseDiff).toHaveBeenCalledTimes(2);
    const panel = view.host.querySelector('[role="tabpanel"]')!;
    expect(panel.textContent).toContain("second_after");
    expect(panel.textContent).not.toContain("first_after");
  } finally { await view.close(); }
});
