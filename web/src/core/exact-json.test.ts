import {afterEach, describe, expect, it, vi} from "vitest";
import {ApiClient} from "./api-client";
import {exactProperty, parseExactJson, stringifyExact} from "./exact-json";
import {diffValue, jsonPreview, numericFields} from "../rvx/snapshot-utils";
import type {SnapshotDiffResponse, SnapshotLatestResponse} from "../domain/snapshots";

const state = '{"big":9007199254740993,"max":18446744073709551615,"min":-9223372036854775808,"array":[9007199254740993,null,true],"decimal":1.0000000000000001,"negative_zero":-0,"text":"9007199254740993 \\"quoted\\""}';
const wire = `{"snapshots":[{"id":9007199254740993,"run_id":"r","source_id":"s","source_session_id":"session","sequence":18446744073709551615,"schema_version":1,"observed_at_ns":1788595200000000123,"ingested_at_ns":1788595200000000789,"axes":{"step":9007199254740993},"state":${state}}],"next_source_id":null}`;

afterEach(() => vi.unstubAllGlobals());

describe("exact raw snapshot JSON", () => {
  it("retains numeric lexemes across nested raw state and every envelope field", () => {
    const response = parseExactJson<SnapshotLatestResponse>(wire);
    const snapshot = response.snapshots[0]!;
    expect(typeof snapshot.state.big).toBe("number");
    expect(stringifyExact(snapshot.state)).toBe(state);
    expect(exactProperty(snapshot, "id")).toBe("9007199254740993");
    expect(exactProperty(snapshot, "sequence")).toBe("18446744073709551615");
    expect(exactProperty(snapshot, "observed_at_ns")).toBe("1788595200000000123");
    expect(exactProperty(snapshot, "ingested_at_ns")).toBe("1788595200000000789");
    expect(stringifyExact(snapshot)).toBe(wire.slice('{"snapshots":['.length, wire.indexOf('],"next_source_id"')));
    expect(jsonPreview(snapshot.state).text).toContain('"big": 9007199254740993');
    expect(jsonPreview(snapshot.state, 12)).toEqual({text: stringifyExact(snapshot.state, 2).slice(0, 12), truncated: true});
    expect(numericFields(snapshot.state).paths).toContain("/big");
  });

  it("preserves scalar diff numbers, nested numbers, null, and absent properties", () => {
    const response = parseExactJson<SnapshotDiffResponse>('{"before_id":1,"after_id":2,"truncated":false,"changes":[{"kind":"changed","path":"/big","before":9007199254740993,"after":18446744073709551615},{"kind":"added","path":"/nested","after":{"n":-9223372036854775808}},{"kind":"removed","path":"/null","before":null}]}');
    expect(diffValue(response.changes[0]!, "before")).toBe("9007199254740993");
    expect(diffValue(response.changes[0]!, "after")).toBe("18446744073709551615");
    expect(diffValue(response.changes[1]!, "after")).toBe('{"n":-9223372036854775808}');
    expect(diffValue(response.changes[2]!, "before")).toBe("null");
    expect(diffValue(response.changes[2]!, "after")).toBe("(absent)");
  });

  it("does not apply retained lexemes to subsequently changed values", () => {
    const value = parseExactJson<{n: number}>('{"n":9007199254740993}');
    value.n = 7;
    expect(stringifyExact(value)).toBe('{"n":7}');
  });

  it("fails explicitly rather than silently rounding in unsupported browsers", () => {
    vi.stubGlobal("JSON", {parse: JSON.parse, stringify: JSON.stringify});
    expect(() => parseExactJson(wire)).toThrow("rounded snapshot data will not be displayed");
  });

  it("requires source-context support as well as rawJSON support", () => {
    const native = JSON;
    vi.stubGlobal("JSON", {
      ...native,
      rawJSON: (native as typeof JSON & {rawJSON: (text: string) => object}).rawJSON,
      parse: (text: string, reviver?: (this: object, key: string, value: unknown) => unknown) =>
        native.parse(text, function(this: object, key: string, value: unknown) {
          return reviver ? reviver.call(this, key, value) : value;
        }),
      stringify: native.stringify,
    });
    expect(() => parseExactJson(wire)).toThrow("native JSON.parse source context");
  });

  it("uses the exact codec for latest/history/diff transport without changing numeric projection types", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(
      url.endsWith("/diff")
        ? '{"before_id":1,"after_id":2,"truncated":false,"changes":[{"kind":"changed","path":"/n","before":9007199254740993,"after":18446744073709551615}]}'
        : url.endsWith("/query")
          ? '{"axis":"wall_time","series":[{"values":[1.5,null]}]}'
          : wire,
      {headers: {"Content-Type": "application/json"}},
    )));
    const api = new ApiClient();
    const latest = await api.snapshotLatest({run_id: "r"});
    expect(stringifyExact(latest.snapshots[0])).toContain('"observed_at_ns":1788595200000000123');
    const history = await api.snapshotHistory({run_id: "r"});
    expect(stringifyExact(history.snapshots[0])).toContain('"max":18446744073709551615');
    const diff = await api.snapshotDiff({before_id: 1, after_id: 2});
    expect(diffValue(diff.changes[0]!, "before")).toBe("9007199254740993");
    const query = await api.snapshotQuery({run_ids: ["r"], paths: ["/n"]});
    expect(query.series[0]!.values).toEqual([1.5, null]);
  });
});
