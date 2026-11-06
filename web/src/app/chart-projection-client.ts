import type {SnapshotQuerySeries} from "../domain/snapshots";
import {projectionRequest, type ChartProjection, type ChartProjectionMessage, type ChartProjectionResponse} from "./chart-projection";

export interface ChartProjectionInput {
  series: SnapshotQuerySeries[];
  axis: string;
  smoothing: number;
  logarithmic: boolean;
}
export type ChartProjectionResult = {input: ChartProjectionInput; projection: ChartProjection; error: null}
  | {input: ChartProjectionInput; projection: null; error: string};

/** Match replies to the exact main-thread provenance object, never a cloned snapshot ID. */
export function chartProjectionSession(send: (message: ChartProjectionMessage) => void,
  receive: (result: ChartProjectionResult) => void) {
  let generation = 0;
  let pending: {generation: number; input: ChartProjectionInput} | null = null;
  let current: ChartProjectionInput | null = null;
  function cancel() {
    if (pending) send({type: "cancel", generation: pending.generation});
    pending = null; current = null;
  }
  return {
    request(input: ChartProjectionInput) {
      cancel();
      current = input;
      pending = {generation: ++generation, input};
      send(projectionRequest(generation, input.series, input.axis, input.smoothing, input.logarithmic));
      return generation;
    },
    receive(message: ChartProjectionResponse) {
      if (!pending || message.generation !== pending.generation) return;
      const {input} = pending;
      pending = null;
      receive(message.type === "projected" ? {input, projection: message.projection, error: null}
        : {input, projection: null, error: message.error});
    },
    fail(error: string) {
      if (!current) return;
      pending = null;
      receive({input: current, projection: null, error});
    },
    cancel,
  };
}
