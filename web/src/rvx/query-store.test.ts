import {describe, expect, it} from "vitest";

import type {ExperimentQueryResponse} from "../domain/types";
import {QueryStore, type MetricQueryRequest} from "./query-store";

const REQUEST: MetricQueryRequest = {
  run_id: "run-1",
  metrics: ["train/loss"],
  axis: "optimizer_step",
  max_points: 1600,
};

/** Builds a minimal query response for cache and transport tests. */
function response(
  axis = "optimizer_step",
  runId = "run-1",
): ExperimentQueryResponse {
  return {run_id: runId, axis, series: []};
}

describe("QueryStore", () => {
  it("deduplicates concurrent identical requests", async () => {
    let resolveRequest!: (value: ExperimentQueryResponse) => void;
    let calls = 0;
    const client = {
      queryExperimentMetrics: () => {
        calls += 1;
        return new Promise<ExperimentQueryResponse>(resolve => {
          resolveRequest = resolve;
        });
      },
    };
    const store = new QueryStore(client);

    const first = store.query(REQUEST);
    const second = store.query(REQUEST);
    expect(calls).toBe(1);
    resolveRequest(response());

    await expect(first).resolves.toEqual(response());
    await expect(second).resolves.toEqual(response());
  });

  it("uses TTL caching and bounded LRU eviction", async () => {
    let now = 0;
    let calls = 0;
    const client = {
      queryExperimentMetrics: async (request: MetricQueryRequest) => {
        calls += 1;
        return response(request.axis, request.run_id);
      },
    };
    const store = new QueryStore(client, {
      ttlMs: 10,
      maxEntries: 2,
      now: () => now,
    });
    const request = (runId: string): MetricQueryRequest => ({
      ...REQUEST,
      run_id: runId,
    });

    await store.query(request("a"));
    await store.query(request("b"));
    await store.query(request("a"));
    await store.query(request("c"));
    await store.query(request("b"));
    expect(calls).toBe(4);

    now = 11;
    await store.query(request("a"));
    expect(calls).toBe(5);
  });

  it("keeps shared transport alive while another consumer remains", async () => {
    let resolveRequest!: (value: ExperimentQueryResponse) => void;
    let transportSignal: AbortSignal | undefined;
    const client = {
      queryExperimentMetrics: (
        _request: MetricQueryRequest,
        signal?: AbortSignal,
      ) => {
        transportSignal = signal;
        return new Promise<ExperimentQueryResponse>(resolve => {
          resolveRequest = resolve;
        });
      },
    };
    const store = new QueryStore(client);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = store.query(REQUEST, firstController.signal);
    const second = store.query(REQUEST, secondController.signal);
    firstController.abort();
    await expect(first).rejects.toMatchObject({name: "AbortError"});
    expect(transportSignal?.aborted).toBe(false);

    resolveRequest(response());
    await expect(second).resolves.toEqual(response());
  });

  it("aborts transport after its final consumer leaves", async () => {
    let transportSignal: AbortSignal | undefined;
    const client = {
      queryExperimentMetrics: (
        _request: MetricQueryRequest,
        signal?: AbortSignal,
      ) => {
        transportSignal = signal;
        return new Promise<ExperimentQueryResponse>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("cancelled", "AbortError"));
          });
        });
      },
    };
    const store = new QueryStore(client);
    const controller = new AbortController();

    const pending = store.query(REQUEST, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({name: "AbortError"});
    expect(transportSignal?.aborted).toBe(true);
  });

  it("replaces an aborted request before its cleanup microtask runs", async () => {
    let calls = 0;
    const client = {
      queryExperimentMetrics: (
        request: MetricQueryRequest,
        signal?: AbortSignal,
      ) => {
        calls += 1;
        if (calls > 1) return Promise.resolve(response(request.axis));
        return new Promise<ExperimentQueryResponse>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("cancelled", "AbortError"));
          });
        });
      },
    };
    const store = new QueryStore(client);
    const controller = new AbortController();

    const cancelled = store.query(REQUEST, controller.signal);
    controller.abort();
    const replacement = store.query(REQUEST);

    await expect(cancelled).rejects.toMatchObject({name: "AbortError"});
    await expect(replacement).resolves.toEqual(response());
    expect(calls).toBe(2);
  });
});
