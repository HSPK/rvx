import {describe, expect, it} from "vitest";
import {logicalBound} from "./snapshot-range";

describe("logical projection bounds", () => {
  it("accepts optional signed safe integers, including zero and both endpoints", () => {
    expect(logicalBound("")).toBeUndefined();
    expect(logicalBound("-12")).toBe(-12);
    expect(logicalBound("+12")).toBe(12);
    expect(logicalBound("0")).toBe(0);
    expect(logicalBound("-9007199254740991")).toBe(Number.MIN_SAFE_INTEGER);
    expect(logicalBound("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("rejects dates, fractional numbers, and integers that cannot be represented exactly", () => {
    for (const value of ["2026-09-05", "0.5", "NaN", "Infinity", "9007199254740992", "-9007199254740992", "0x10"]) {
      expect(() => logicalBound(value)).toThrow("signed safe integers");
    }
  });
});
