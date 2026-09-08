import {describe, expect, it} from "vitest";
import {decimalDisplay} from "./decimal-display";

describe("exact decimal display", () => {
  it.each([
    ["1.005", 2, "1.01"], ["-1.005", 2, "-1.01"], ["9.999", 2, "10.00"],
    ["18446744073709551615", 2, "18446744073709551615.00"],
    ["-9223372036854775808", 0, "-9223372036854775808"],
    ["1.2345e3", 1, "1234.5"], ["1.25e-2", 3, "0.013"],
    ["-0.0001", 2, "0.00"], ["0", 0, "0"], ["1", 20, "1.00000000000000000000"],
    ["5e-324", 20, "0.00000000000000000000"], ["9.5", 0, "10"],
  ])("formats %s at %i places without changing the source", (text, places, result) => {
    expect(decimalDisplay(text, places)).toBe(result);
    expect(decimalDisplay(text, undefined)).toBe(text);
  });
  it("bounds extreme exponents and rejects invalid precision instead of rounding unpredictably", () => {
    expect(decimalDisplay("1e1000000", 2)).toBe("1e1000000");
    expect(decimalDisplay("1e-1000000", 2)).toBe("0.00");
    for (const places of [-1, 1.5, 21, NaN]) expect(() => decimalDisplay("1", places)).toThrow(RangeError);
    expect(() => decimalDisplay("NaN", 2)).toThrow(TypeError);
  });
});
