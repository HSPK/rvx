import {describe, expect, it} from "vitest";
import {elapsedIncrements, elapsedTick, formatTimeBound, parseTimeBound} from "./time";

describe("human chart bounds", () => {
  it.each([
    ["", undefined], ["0", 0], ["30s", 30e9], ["5m", 300e9], ["1h 15m", 4500e9],
    ["1.5h", 5400e9], ["1h15m", 4500e9], ["-30s", -30e9], ["2D", 172800e9],
    ["1ms 250us", 1250000], ["1.000000001s", 1000000001], ["1ns", 1],
  ])("parses %s without changing elapsed nanosecond units", (text, value) => {
    expect(parseTimeBound(String(text), "elapsed")).toEqual({ok: true, value});
  });
  it.each(["1x", "10 monkeys", "1h + 15m", "1e3s", "0.1ns", "300000d", "9".repeat(129)])("rejects invalid or unsupported duration %s", text => {
    expect(parseTimeBound(text, "elapsed").ok).toBe(false);
  });
  it("keeps logical axes integer-valued and rejects silent rounding or storage overflow", () => {
    expect(parseTimeBound("-42", "optimizer_step")).toEqual({ok: true, value: -42});
    expect(parseTimeBound("1.5", "optimizer_step").ok).toBe(false);
    expect(parseTimeBound("9007199254740993", "optimizer_step").ok).toBe(false);
    expect(parseTimeBound("9223372036854775808", "optimizer_step").ok).toBe(false);
  });
  it("uses local wall dates and rejects normalized invalid calendar dates", () => {
    const date = new Date(2026, 8, 5, 12, 30, 15);
    expect(parseTimeBound("2026-09-05T12:30:15", "wall_time")).toEqual({ok: true, value: date.getTime() * 1e6});
    expect(formatTimeBound(date.getTime() * 1e6, "wall_time")).toBe("2026-09-05T12:30:15");
    expect(parseTimeBound("2026-02-30T12:30", "wall_time").ok).toBe(false);
    expect(parseTimeBound("2026-09-05T12:30:15.1", "wall_time").ok).toBe(false);
    expect(parseTimeBound("3000-01-01T00:00", "wall_time").ok).toBe(false);
  });
  it("formats editable durations without truncating fractional or zero bounds", () => {
    expect(formatTimeBound(4500e9, "elapsed")).toBe("1h 15m");
    expect(formatTimeBound(1000000001, "elapsed")).toBe("1.000000001s");
    expect(formatTimeBound(0, "elapsed")).toBe("0s");
    expect(formatTimeBound(-1e9, "elapsed")).toBe("-1s");
    expect(formatTimeBound(undefined, "elapsed")).toBe("");
  });
});

describe("elapsed axis presentation", () => {
  it("supplies ordered time-aware steps without arbitrary 5000-second intervals", () => {
    expect(elapsedIncrements).toEqual([...elapsedIncrements].sort((a, b) => a - b));
    expect(elapsedIncrements).toContain(1800);
    expect(elapsedIncrements).toContain(7200);
    expect(elapsedIncrements).not.toContain(5000);
  });
  it.each([[0, "0s"], [1e-9, "1ns"], [.0005, "500us"], [.5, "500ms"], [30, "30s"], [900, "15m"], [3600, "1h"], [5400, "1h 30m"], [172800, "2d"], [-60, "-1m"]])("formats %s seconds as %s", (seconds, text) => {
    expect(elapsedTick(Number(seconds))).toBe(text);
  });
});
