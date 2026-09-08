import {describe, expect, it} from "vitest";
import {readWeight, recordReadWeight} from "./read-weight";

describe("read response accounting", () => {
  it("uses transport weight without serializing the decoded result again", () => {
    const response = {state: {n: 3}};
    recordReadWeight(response, 1000);
    expect(readWeight(response)).toBe(8000);
  });
  it("bounds fallback traversal for unaccounted clients", () => {
    expect(readWeight({value: "x"})).toBeGreaterThan(0);
    expect(readWeight(Array.from({length: 50_001}, () => null))).toBe(Infinity);
  });
});
