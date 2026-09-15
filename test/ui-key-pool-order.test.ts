import path from "node:path";
import { describe, expect, it } from "vitest";
import { DIRECT_API_KEY_ID } from "../src/shared/api-key-priority.js";
import { ConfigStore } from "../src/server/config.js";
import { enabledApiKeyPool } from "../src/server/credentials.js";
import { orderedKeys, moveKeyInOrder } from "../src/ui/config/key-pool-order.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

describe("key order", () => {
  it("moves 1234 to 2134 and 3214, including the direct key, without mutating entries", () => {
    const initial = [DIRECT_API_KEY_ID, "2", "3", "4"].map((id) => ({ id, priority: 0 }));
    const first = moveKeyInOrder(initial, "2", DIRECT_API_KEY_ID, "before")!;
    expect(first.map((entry) => entry.id)).toEqual(["2", DIRECT_API_KEY_ID, "3", "4"]);
    const second = moveKeyInOrder(first, "3", "2", "before")!;
    expect(second.map((entry) => entry.id)).toEqual(["3", "2", DIRECT_API_KEY_ID, "4"]);
    expect(initial.every((entry) => entry.priority === 0)).toBe(true);
    expect(moveKeyInOrder(second, "3", "2", "before")).toBeNull();
    expect(moveKeyInOrder(second, "missing", "2", "before")).toBeNull();
    expect(moveKeyInOrder(second, "2", "missing", "before")).toBeNull();
    expect(moveKeyInOrder(second, "2", "2", "after")).toBeNull();
    expect(moveKeyInOrder(second, "3", "4", "after")!.map((entry) => entry.id)).toEqual(["2", DIRECT_API_KEY_ID, "4", "3"]);
  });

  it("round-trips the order through config without restating secrets or changing enabled flags", async () => {
    const file = path.join(await makeConfigDir(), "config.json");
    const store = await ConfigStore.load(file);
    await store.patch({ primary: { api_key: "synthetic-direct", api_keys: [
      { id: "2", label: "Second", api_key: "synthetic-second", enabled: true },
      { id: "3", label: "Third", api_key: "synthetic-third", enabled: true },
      { id: "4", label: "Fourth", api_key: "synthetic-fourth", enabled: false }
    ] } });
    const initial = [DIRECT_API_KEY_ID, "2", "3", "4"].map((id) => ({ id, priority: 0 }));
    const order = moveKeyInOrder(moveKeyInOrder(initial, "2", DIRECT_API_KEY_ID, "before")!, "3", "2", "before")!;
    await store.patch({ primary: {
      api_key_priority: order.find((entry) => entry.id === DIRECT_API_KEY_ID)!.priority,
      api_keys: order.filter((entry) => entry.id !== DIRECT_API_KEY_ID)
    } });
    const reopened = await ConfigStore.load(file);
    expect(enabledApiKeyPool(reopened.get().primary).map((entry) => entry.id)).toEqual(["3", "2", DIRECT_API_KEY_ID]);
    expect(reopened.get().primary.api_keys).toEqual([
      { id: "3", label: "Third", api_key: "synthetic-third", enabled: true, priority: 100 },
      { id: "2", label: "Second", api_key: "synthetic-second", enabled: true, priority: 99 },
      { id: "4", label: "Fourth", api_key: "synthetic-fourth", enabled: false, priority: 97 }
    ]);
    expect(orderedKeys(initial).map((entry) => entry.id)).toEqual([DIRECT_API_KEY_ID, "2", "3", "4"]);
  });
});
