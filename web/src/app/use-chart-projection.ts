import {useEffect, useRef, useState} from "react";
import type {SnapshotQuerySeries} from "../domain/snapshots";
import type {ChartProjection, ChartProjectionResponse} from "./chart-projection";
import {chartProjectionSession, type ChartProjectionInput} from "./chart-projection-client";

interface ProjectionState {
  input: ChartProjectionInput | null;
  projection: ChartProjection | null;
  pending: boolean;
  error: string | null;
}
const emptySources: SnapshotQuerySeries[] = [];

export function useChartProjection(series: SnapshotQuerySeries[], axis: string, smoothing: number,
  logarithmic: boolean, active: boolean) {
  const stable = useRef(series);
  if (series.length !== stable.current.length || series.some((item, index) => item !== stable.current[index])) stable.current = series;
  const sources = stable.current;
  const enabled = active && sources.length > 0;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ProjectionState>({input: null, projection: null, pending: false, error: null});
  const lifetime = useRef<{worker: Worker; session: ReturnType<typeof chartProjectionSession>} | null>(null);

  useEffect(() => () => {
    lifetime.current?.session.cancel();
    lifetime.current?.worker.terminate();
    lifetime.current = null;
  }, []);

  useEffect(() => {
    if (!enabled) {
      lifetime.current?.session.cancel();
      setState(previous => previous.pending ? {...previous, pending: false} : previous);
      return;
    }
    const input = {series: sources, axis, smoothing, logarithmic};
    setState(previous => ({...previous, pending: true, error: null}));
    try {
      if (!lifetime.current) {
        const worker = new Worker(new URL("./chart-projection.worker.ts", import.meta.url), {type: "module"});
        const session = chartProjectionSession(message => worker.postMessage(message), result => {
          setState(previous => result.error ? {...previous, pending: false, error: result.error}
            : {input: result.input, projection: result.projection, pending: false, error: null});
        });
        const fail = (message: string) => {
          session.fail(message);
          worker.terminate();
          if (lifetime.current?.worker === worker) lifetime.current = null;
        };
        worker.onmessage = (event: MessageEvent<ChartProjectionResponse>) => session.receive(event.data);
        worker.onerror = event => {event.preventDefault(); fail(event.message || "Chart worker failed. Retry to restart it.");};
        worker.onmessageerror = () => fail("Could not read chart worker output. Retry to restart it.");
        lifetime.current = {worker, session};
      }
      lifetime.current.session.request(input);
    } catch (error) {
      lifetime.current?.worker.terminate(); lifetime.current = null;
      setState(previous => ({...previous, pending: false,
        error: error instanceof Error ? error.message : "Could not start chart worker."}));
    }
    return () => lifetime.current?.session.cancel();
  }, [sources, axis, smoothing, logarithmic, enabled, revision]);

  const matches = state.input?.series === sources && state.input.axis === axis
    && state.input.smoothing === smoothing && state.input.logarithmic === logarithmic;
  const pending = enabled && !state.error && (state.pending || !matches);
  return {
    projection: state.projection, series: sources.length ? state.input?.series ?? emptySources : emptySources, pending, error: state.error,
    ready: enabled && matches && !pending && !state.error,
    retry: () => setRevision(value => value + 1),
  };
}
