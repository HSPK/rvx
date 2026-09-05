import {afterEach, describe, expect, it, vi} from "vitest";

import {readBrowserStorage} from "./browser-storage";

afterEach(() => vi.unstubAllGlobals());

describe("legacy browser-state migration", () => {
  it.each([
    ["rvx.workspace.snapshots.v1", "ryx.workspace.snapshots.v1", '{"tabs":[{"id":"saved"}]}'],
    ["rvx.layout.context", "ryx.layout.context", "312"],
    ["rvx.layout.split", "ryx.layout.split", "62"],
  ] as const)("copies %s on first read without overwriting newer state", (key, legacyKey, value) => {
    const values = new Map([[legacyKey as string, value as string]]);
    const storage = {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: vi.fn((name: string, content: string) => values.set(name, content)),
    };
    vi.stubGlobal("window", {localStorage: storage});

    expect(readBrowserStorage(key)).toBe(value);
    expect(values.get(key)).toBe(value);
    expect(values.get(legacyKey)).toBe(value);
    expect(readBrowserStorage(key)).toBe(value);
    expect(storage.setItem).toHaveBeenCalledTimes(1);

    values.set(key, "newer state");
    expect(readBrowserStorage(key)).toBe("newer state");
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("still reads legacy state if the migration cannot be persisted", () => {
    vi.stubGlobal("window", {localStorage: {
      getItem: (key: string) => key === "ryx.layout.context" ? "312" : null,
      setItem: () => { throw new Error("Storage is full"); },
    }});
    expect(readBrowserStorage("rvx.layout.context")).toBe("312");
  });

  it("does not invent preferences when browser storage is unavailable", () => {
    vi.stubGlobal("window", {
      get localStorage() { throw new Error("Storage is blocked"); },
    });
    expect(readBrowserStorage("rvx.workspace.snapshots.v1")).toBeNull();
  });
});
