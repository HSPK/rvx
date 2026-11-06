import {describe, expect, it} from "vitest";
import {endpointTicks} from "./chart-ticks";

describe("endpoint axis labels", () => {
  it("adds exact observations and removes overlapping interior ticks", () => {
    expect(endpointTicks([0, 20, 40, 60, 80, 100], 3, 97, 0, 100, 10)).toEqual([3, 20, 40, 60, 80, 97]);
  });
  it("does not reintroduce observations outside a zoomed range", () => {
    expect(endpointTicks([20, 40, 60, 80], 3, 97, 25, 75, 10)).toEqual([40, 60]);
  });
  it("deduplicates single observations and ignores absent coordinates", () => {
    expect(endpointTicks([5], 5, 5, 0, 10, 0)).toEqual([5]);
    expect(endpointTicks([2, 4], NaN, NaN, 0, 10, 2)).toEqual([2, 4]);
  });
});
