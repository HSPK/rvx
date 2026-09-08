import {afterEach, describe, expect, it, vi} from "vitest";
import {configurationPreview} from "./run-details";

afterEach(() => vi.unstubAllGlobals());

describe("bounded exact Run configuration", () => {
  it("formats objects and scalar roots without rounding large integers", () => {
    const preview = configurationPreview('{"batch_size":128,"seed":18446744073709551615,"nested":{"enabled":true}}');
    expect(preview.notice).toBeNull();
    expect(preview.text).toContain('"seed": 18446744073709551615');
    expect(preview.text).toContain('\n  "batch_size": 128');
    expect(configurationPreview("18446744073709551615").text).toBe("18446744073709551615");
    expect(configurationPreview("null").text).toBe("null");
    expect(configurationPreview('[null,true,""]')).toMatchObject({notice: null});
  });
  it("keeps invalid input explicit instead of inventing an empty configuration", () => {
    expect(configurationPreview("{broken")).toEqual({text: "{broken", notice: "Invalid configuration JSON. Showing the stored text."});
    expect(configurationPreview('1,"extra":true')).toMatchObject({notice: "Invalid configuration JSON. Showing the stored text."});
  });
  it("bounds large and deep previews without unbounded formatting", () => {
    const large = JSON.stringify({text: "x".repeat(65520) + "😀".repeat(10000)});
    const preview = configurationPreview(large);
    expect(preview.text.length).toBeLessThanOrEqual(65536);
    expect(preview.notice).toContain("limited preview");
    expect(/[\uD800-\uDBFF]$/.test(preview.text)).toBe(false);
    const deep = '{"a":'.repeat(30) + "1" + "}".repeat(30);
    expect(configurationPreview(deep)).toMatchObject({text: deep, notice: expect.stringContaining("without formatting")});
  });
  it("shows original text in browsers without exact-number formatting support", () => {
    const raw = '{"seed":18446744073709551615}';
    vi.stubGlobal("JSON", {parse: JSON.parse, stringify: JSON.stringify});
    expect(configurationPreview(raw)).toEqual({text: raw, notice: "This browser cannot format exact numeric values. Showing the stored JSON."});
  });
  it("does not swallow unexpected programming failures", () => {
    vi.stubGlobal("JSON", {parse: () => {throw new TypeError("unexpected parser defect");}, stringify: JSON.stringify, rawJSON: () => ({})});
    expect(() => configurationPreview("{}")).toThrow("unexpected parser defect");
  });
});
