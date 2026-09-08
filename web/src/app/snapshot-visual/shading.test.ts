import {describe, expect, it} from "vitest";
import type {SnapshotAggregateResponse, SnapshotAggregateValue} from "../../domain/snapshot-views";
import type {TableCell} from "../../domain/tables";
import {statusShade, statusShadeDomain} from "./shading";

const cell = (text: string, kind: TableCell["kind"] = "number"): TableCell => ({kind, text, truncated: false});
const measure = (text: string, count = 5): SnapshotAggregateValue => ({
  value: cell(text, count ? "number" : "missing"), count, missing: 0, non_numeric: 0, approximate: false,
});
const response = (minimum: string, maximum: string, count = 5, total = count): SnapshotAggregateResponse => ({
  groups: [{key: "Running", cells: [cell("Running", "string")], series: [{
    run_id: "run", source_id: "source", snapshot_id: "1",
    measures: {count: measure(String(total), total), shade_min: measure(minimum, count), shade_max: measure(maximum, count)},
  }]}], total_groups: 1, matched_rows: total, snapshots: [], offset: 0, limit: 128,
});

describe("snapshot field-based shading", () => {
  it("combines complete Source/state extrema rather than adapting the scale to the visible page", () => {
    const data = response("0", "10", 5, 8);
    data.groups[0]!.series.push({...data.groups[0]!.series[0]!, source_id: "other",
      measures: {count: measure("5"), shade_min: measure("-50"), shade_max: measure("200")}});
    data.matched_rows = 13;
    const domain = statusShadeDomain(data);
    expect(domain.unavailable).toBe(3);
    expect(statusShade(cell("-50"), domain)).toBe(0);
    expect(statusShade(cell("75"), domain)).toBe(.5);
    expect(statusShade(cell("200"), domain)).toBe(1);
  });
  it.each([
    ["18446744073709551611", "18446744073709551615", "18446744073709551613"],
    ["-9223372036854775808", "-9223372036854775804", "-9223372036854775806"],
    ["1.00000000000000000000000001", "1.00000000000000000000000003", "1.00000000000000000000000002"],
    ["0", "1e400", "5e399"],
    ["0", "1e-1000000", "5e-1000001"],
    ["-1e1000000", "1e1000000", "0"],
  ])("normalizes %s..%s without rounded subtraction or exponent-sized allocation", (low, high, middle) => {
    const domain = statusShadeDomain(response(low, high));
    expect(statusShade(cell(low), domain)).toBe(0);
    expect(statusShade(cell(middle), domain)).toBe(.5);
    expect(statusShade(cell(high), domain)).toBe(1);
  });
  it("uses a neutral midpoint for constant fields, including equivalent decimal representations", () => {
    expect(statusShade(cell("1e0"), statusShadeDomain(response("1", "1.0")))).toBe(.5);
    expect(statusShade(cell("0"), statusShadeDomain(response("-0", "0e999999999")))).toBe(.5);
  });
  it("keeps absent, null, numeric strings and truncated previews out of the numeric scale", () => {
    const domain = statusShadeDomain(response("0", "10"));
    for (const value of [undefined, cell("", "missing"), cell("null", "null"), cell("0", "string"), {...cell("123"), truncated: true}]) {
      expect(statusShade(value, domain)).toBeNull();
    }
    const empty = statusShadeDomain(response("", "", 0, 5));
    expect(empty).toMatchObject({bounds: null, unavailable: 5});
    expect(statusShade(undefined, empty)).toBeNull();
    expect(() => statusShade(cell("0"), empty)).toThrow("does not cover");
  });
  it("rejects incomplete or inconsistent ranges before a new shade frame can be committed", () => {
    const data = response("0", "10");
    delete data.groups[0]!.series[0]!.measures.shade_max;
    expect(() => statusShadeDomain(data)).toThrow("incomplete");
    expect(() => statusShadeDomain(response("10", "0"))).toThrow("invalid");
    expect(() => statusShadeDomain(response("0", "10", 6, 5))).toThrow("incomplete");
    const truncated = response("0", "10");
    truncated.groups[0]!.series[0]!.measures.shade_min!.value.truncated = true;
    expect(() => statusShadeDomain(truncated)).toThrow("truncated");
    expect(() => statusShade(cell("11"), statusShadeDomain(response("0", "10")))).toThrow("does not cover");
    expect(() => statusShade(cell("NaN"), statusShadeDomain(response("0", "10")))).toThrow("numeric text");
  });
  it("separates common GPU sizes despite a 1344-GPU outlier without changing raw values", () => {
    const data = response("2", "1344");
    data.groups[0]!.series[0]!.measures.shade_min!.minimum_magnitude = cell("2");
    const log = statusShadeDomain(data, "log"), linear = statusShadeDomain(data);
    const values = ["2", "4", "8", "16", "32", "64", "1344"];
    const shades = values.map(value => statusShade(cell(value), log)!);
    expect(shades[0]).toBe(0); expect(shades.at(-1)).toBeCloseTo(1);
    for (let index = 1; index < shades.length; index++) expect(shades[index]! - shades[index - 1]!).toBeGreaterThan(.06);
    expect(statusShade(cell("64"), log)).toBeGreaterThan(statusShade(cell("64"), linear)! * 8);
    expect(data.groups[0]!.series[0]!.measures.shade_max!.value.text).toBe("1344");
  });
  it.each([
    ["0", "8", "1", "4"],
    ["-8", "8", "1", "0"],
    ["-1344", "-2", "2", "-64"],
    ["0", "8e-1000000", "1e-1000000", "4e-1000000"],
    ["18446744073709551611", "18446744073709551615", "18446744073709551611", "18446744073709551613"],
  ])("uses a signed, unit-independent log scale for %s..%s", (low, high, anchor, value) => {
    const data = response(low, high); data.groups[0]!.series[0]!.measures.shade_min!.minimum_magnitude = cell(anchor);
    const domain = statusShadeDomain(data, "log");
    expect(statusShade(cell(low), domain)).toBe(0); expect(statusShade(cell(high), domain)).toBeCloseTo(1);
    const result = statusShade(cell(value), domain)!;
    if (value === "0" || value === "18446744073709551613") expect(result).toBe(.5);
    else if (low === "0") expect(result).toBeCloseTo(Math.log1p(4) / Math.log1p(8));
    else expect(result).toBeGreaterThan(.4);
  });
  it("normalizes logarithms with exponents too large for Number without allocating their expanded values", () => {
    const exponent = BigInt("9".repeat(400));
    const data = response("0", `1e${exponent}`);
    data.groups[0]!.series[0]!.measures.shade_min!.minimum_magnitude = cell("1");
    expect(statusShade(cell(`1e${exponent / 2n}`), statusShadeDomain(data, "log"))).toBeCloseTo(.5, 6);
  });
  it("requires authoritative full-scope log metadata, not a visible-page estimate", () => {
    expect(() => statusShadeDomain(response("0", "10"), "log")).toThrow("magnitude is incomplete");
    const data = response("0", "10");
    data.groups[0]!.series[0]!.measures.shade_min!.minimum_magnitude = cell("2");
    expect(() => statusShade(cell("1"), statusShadeDomain(data, "log"))).toThrow("does not cover");
    expect(statusShade(cell("0"), statusShadeDomain(response("0", "0"), "log"))).toBe(.5);
  });
  it("uses the smallest nonzero magnitude from every Source, including those absent from a page", () => {
    const data = response("0", "100");
    data.groups[0]!.series[0]!.measures.shade_min!.minimum_magnitude = cell("10");
    const other = response("0", "2").groups[0]!.series[0]!;
    other.source_id = "other"; other.measures.shade_min!.minimum_magnitude = cell("0.1");
    data.groups[0]!.series.push(other); data.matched_rows = 10;
    expect(statusShade(cell("10"), statusShadeDomain(data, "log"))).toBeCloseTo(Math.log1p(100) / Math.log1p(1000));
  });
});
