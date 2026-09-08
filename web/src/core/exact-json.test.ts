import {afterEach, describe, expect, it, vi} from "vitest";
import {ApiClient} from "./api-client";
import {exactProperty, parseExactJson, parseExactProjection, stringifyExact} from "./exact-json";
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
    expect(exactProperty(snapshot.state, "big")).toBe("9007199254740993");
  });

  it("preserves scalar diff numbers, nested numbers, null, and absent properties", () => {
    const response = parseExactJson<SnapshotDiffResponse>('{"before_id":1,"after_id":2,"truncated":false,"changes":[{"kind":"changed","path":"/big","before":9007199254740993,"after":18446744073709551615},{"kind":"added","path":"/nested","after":{"n":-9223372036854775808}},{"kind":"removed","path":"/null","before":null}]}');
    expect(exactProperty(response.changes[0]!, "before")).toBe("9007199254740993");
    expect(exactProperty(response.changes[0]!, "after")).toBe("18446744073709551615");
    expect(exactProperty(response.changes[1]!, "after")).toBe('{"n":-9223372036854775808}');
    expect(exactProperty(response.changes[2]!, "before")).toBe("null");
    expect(Object.hasOwn(response.changes[2]!, "after")).toBe(false);
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

  it("retains exact projection IDs without changing numeric values or fetching raw snapshots", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"axis":"wall_time","series":[{"snapshot_ids":[9007199254740993,18446744073709551615],"values":[1.5,null]}]}',
      {headers: {"Content-Type": "application/json"}},
    )));
    const api = new ApiClient();
    const query = await api.query({run_ids: ["r"], paths: ["/n"]});
    expect(query.series[0]!.values).toEqual([1.5, null]);
    expect(exactProperty(query.series[0]!.snapshot_ids, "0")).toBe("9007199254740993");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/snapshots/query", expect.objectContaining({credentials: "same-origin"}));
  });

  it("cooperatively decodes trace sidecars without cloning or confusing escaped metadata with structure", async () => {
    const wire = '{"axis":"series","series":[{"path":"/a}b","source_id":"\\"series\\":[{\\"id\\":5}]","snapshot_ids":[9007199254740993],"sequences":[18446744073709551615],"values":[1.0000000000000001],"axes":[-9223372036854775808],"observed_at_ns":[1788595200000000123]},{"path":"/x","snapshot_ids":[2],"values":[null]}]}';
    const query = await parseExactProjection(wire);
    expect(stringifyExact(query)).toBe(wire);
    expect(exactProperty(query.series[0]!.snapshot_ids, "0")).toBe("9007199254740993");
    const controller = new AbortController(); controller.abort();
    await expect(parseExactProjection(wire, controller.signal)).rejects.toMatchObject({name: "AbortError"});
  });
});
