import {afterEach, describe, expect, it, vi} from "vitest";
import type {SnapshotQuerySeries} from "../domain/snapshots";
import {parseExactJson} from "../core/exact-json";
import {pointId} from "./model";
import {chartProjectionSession, type ChartProjectionInput} from "./chart-projection-client";
import {projectChart, projectionRequest, type ChartProjectionMessage, type ChartProjectionResponse} from "./chart-projection";

const series = (axes: number[], values: (number | null)[]): SnapshotQuerySeries => ({
  run_id: "run", source_id: "source", path: "/loss", axes, values, snapshot_ids: axes.map((_, index) => index + 1),
  sequences: axes, observed_at_ns: axes, source_session_ids: axes.map(() => "session"),
});
const input = (source = series([0, 1e9], [1, 2])): ChartProjectionInput =>
  ({series: [source], axis: "elapsed", smoothing: 0, logarithmic: false});

afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

describe("chart worker numeric projections", () => {
  it("aligns sparse reporters with real null gaps, duplicate coordinates, and EMA in the worker projection", () => {
    const request = projectionRequest(1, [series([0, 2e9, 0, 4e9], [2, null, 4, 8]), series([1e9, 3e9], [10, 20])], "elapsed", .5, false);
    const projected = projectChart(request);
    expect(projected.data).toEqual([
      [0, 1, 2, 3, 4], [4, undefined, null, undefined, 6], [undefined, 10, undefined, 15, undefined],
    ]);
    expect(projected.coordinates[0]).toEqual({axes: [0, 2e9, 4e9], indices: [2, 1, 3]});
  });

  it("keeps all exact provenance on the main thread through structured cloning", () => {
    const source = parseExactJson<SnapshotQuerySeries>(JSON.stringify(series([0, 1], [1, 2]))
      .replace('"snapshot_ids":[1,2]', '"snapshot_ids":[9007199254740993,9007199254740995]'));
    const sourceInput = input(source), sent: ChartProjectionMessage[] = [];
    const receive = vi.fn();
    const session = chartProjectionSession(message => sent.push(message), receive);
    const generation = session.request(sourceInput);
    const request = sent[0]!;
    expect(request.type).toBe("project");
    if (request.type !== "project") throw new Error("Missing projection request");
    const cloned = structuredClone(request);
    expect(Object.keys(cloned.series[0]!)).toEqual(["axes", "values"]);
    expect(cloned.series[0]).not.toHaveProperty("snapshot_ids");
    session.receive({type: "projected", generation, projection: projectChart(cloned)});
    const result = receive.mock.calls[0]![0];
    expect(result.input.series[0]).toBe(source);
    expect(pointId(result.input.series[0], result.projection.coordinates[0].indices[1])).toBe("9007199254740995");
  });

  it("rejects stale and cancelled generations without replacing a newer chart projection", () => {
    const sent: ChartProjectionMessage[] = [], receive = vi.fn();
    const session = chartProjectionSession(message => sent.push(message), receive);
    const first = session.request(input());
    const newerInput = input(series([0, 1], [10, 20]));
    const second = session.request(newerInput);
    expect(sent[1]).toEqual({type: "cancel", generation: first});
    const projection = projectChart(projectionRequest(second, newerInput.series, "elapsed", 0, false));
    session.receive({type: "projected", generation: first, projection});
    session.receive({type: "error", generation: first, error: "stale failure"});
    expect(receive).not.toHaveBeenCalled();
    session.receive({type: "projected", generation: second, projection});
    expect(receive).toHaveBeenCalledExactlyOnceWith({input: newerInput, projection, error: null});
    const third = session.request(input());
    session.cancel();
    session.receive({type: "projected", generation: third, projection});
    session.fail("worker stopped");
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it("reports failed projections explicitly rather than returning an untransformed fallback", () => {
    expect(() => projectChart(projectionRequest(1, [series([0], [Infinity])], "step", 0, false))).toThrow(/finite numeric/);
    expect(() => projectChart(projectionRequest(1, [], "step", 1, false))).toThrow(/smoothing/);
    expect(projectChart(projectionRequest(1, [series([0, 1, 2], [-1, 0, 2])], "step", 0, true)).data)
      .toEqual([[0, 1, 2], [null, null, 2]]);
  });
});

describe("chart module worker lifecycle protocol", () => {
  async function worker() {
    vi.useFakeTimers(); vi.resetModules();
    const scope = {onmessage: null as ((event: MessageEvent<ChartProjectionMessage>) => void) | null,
      postMessage: vi.fn<(response: ChartProjectionResponse) => void>()};
    vi.stubGlobal("self", scope);
    await import("./chart-projection.worker");
    return {
      send: (message: ChartProjectionMessage) => scope.onmessage!({data: message} as MessageEvent<ChartProjectionMessage>),
      receive: scope.postMessage,
    };
  }
  it("projects only the newest queued generation and skips cancelled work", async () => {
    const scope = await worker();
    scope.send(projectionRequest(1, input().series, "elapsed", 0, false));
    scope.send(projectionRequest(2, input().series, "elapsed", .5, false));
    await vi.runAllTimersAsync();
    expect(scope.receive).toHaveBeenCalledTimes(1);
    expect(scope.receive.mock.calls[0]![0]).toMatchObject({type: "projected", generation: 2});
    scope.send(projectionRequest(3, input().series, "elapsed", 0, false));
    scope.send({type: "cancel", generation: 3});
    await vi.runAllTimersAsync();
    expect(scope.receive).toHaveBeenCalledTimes(1);
  });
  it("returns structured errors for the failing generation", async () => {
    const scope = await worker();
    scope.send(projectionRequest(4, [series([NaN], [1])], "step", 0, false));
    await vi.runAllTimersAsync();
    expect(scope.receive).toHaveBeenCalledExactlyOnceWith({type: "error", generation: 4,
      error: "Chart projection requires finite numeric coordinates and values."});
  });
});
