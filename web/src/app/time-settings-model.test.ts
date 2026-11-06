import {describe, expect, it} from "vitest";
import {formatTimeBound} from "./time";
import {timeSettingsRange} from "./time-settings-model";

describe("React time settings transaction", () => {
  it("retains relative windows and full nanosecond bounds when visible values are unchanged", () => {
    const range = {axis: "wall_time", window: "3600", timeFormat: "date" as const};
    const bounds = {from: new Date(2026, 8, 5, 12).getTime() * 1e6 + 512, to: new Date(2026, 8, 5, 13).getTime() * 1e6 + 512};
    expect(timeSettingsRange(range, bounds, range.axis, formatTimeBound(bounds.from, range.axis), formatTimeBound(bounds.to, range.axis), "date"))
      .toEqual({ok: true, range});
    const custom = {...range, window: "custom", ...bounds};
    expect(timeSettingsRange(custom, bounds, range.axis, formatTimeBound(bounds.from, range.axis), formatTimeBound(bounds.to, range.axis), "auto"))
      .toEqual({ok: true, range: {axis: "wall_time", window: "custom", ...bounds}});
  });
  it("applies changed alignment with parsed native coordinates and no stale bounds", () => {
    expect(timeSettingsRange({axis: "elapsed", window: "all"}, {}, "optimizer_step", "0", "42", "auto"))
      .toEqual({ok: true, range: {axis: "optimizer_step", window: "custom", from: 0, to: 42}});
    expect(timeSettingsRange({axis: "elapsed", window: "custom", from: 30e9}, {from: 30e9}, "wall_time", "", "", "time"))
      .toEqual({ok: true, range: {axis: "wall_time", window: "all", timeFormat: "time"}});
  });
  it("rejects malformed or reversed bounds without committing", () => {
    const range = {axis: "elapsed", window: "all"};
    expect(timeSettingsRange(range, {}, "elapsed", "1x", "", "auto")).toMatchObject({ok: false, field: "from"});
    expect(timeSettingsRange(range, {}, "elapsed", "2h", "1h", "auto")).toMatchObject({ok: false, field: "to"});
    expect(timeSettingsRange(range, {}, "elapsed", "", "", "invalid")).toMatchObject({ok: false, field: "format"});
  });
});
