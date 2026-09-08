import {afterEach, describe, expect, it, vi} from "vitest";
import {uiIdentifier} from "./identifiers";

afterEach(() => vi.unstubAllGlobals());

describe("UI identities outside secure contexts", () => {
  it("uses getRandomValues when HTTP disables randomUUID", () => {
    let counter = 0;
    vi.stubGlobal("crypto", {getRandomValues: (words: Uint32Array) => words.fill(++counter)});
    const first = uiIdentifier("set");
    expect(first).toMatch(/^set-[a-f0-9]{32}$/);
    expect(uiIdentifier("set")).not.toBe(first);
  });

  it("keeps non-security UI identities distinct without browser crypto", () => {
    vi.stubGlobal("crypto", undefined);
    expect(uiIdentifier("chart")).not.toBe(uiIdentifier("chart"));
  });
});
