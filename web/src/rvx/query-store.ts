import type {ApiClient} from "../core/api-client";
import type {ExperimentQueryResponse} from "../domain/types";
import type {
  SnapshotLatestRequest, SnapshotLatestResponse,
  SnapshotHistoryRequest, SnapshotHistoryPage,
  SnapshotQueryRequest, SnapshotQueryResponse,
  SnapshotDiffRequest, SnapshotDiffResponse,
} from "../domain/snapshots";

export interface MetricQueryRequest {
  run_id: string;
  source_ids?: string[];
  metrics: string[];
  axis: string;
  from?: number;
  to?: number;
  max_points?: number;
}

type QueryClient = Pick<ApiClient, "queryExperimentMetrics">;

interface QueryStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface PendingQuery<T> {
  controller: AbortController;
  consumers: Set<symbol>;
  promise: Promise<T>;
}

/** Shares bounded read results and cancellable transports across analytical Views. */
export class ReadCache<Request, Response> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry<Response>>();
  private readonly pending = new Map<string, PendingQuery<Response>>();

  constructor(
    private readonly transport: (request: Request, signal: AbortSignal) => Promise<Response>,
    options: QueryStoreOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 4_000;
    this.maxEntries = options.maxEntries ?? 128;
    this.now = options.now ?? (() => performance.now());
  }

  /** Returns a cached result or joins one shared in-flight request. */
  query(
    request: Request,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (signal?.aborted) return Promise.reject(abortError());
    const key = JSON.stringify(request);
    const cached = this.cached(key);
    if (cached) return Promise.resolve(cached);

    const existing = this.pending.get(key);
    const pending = existing && !existing.controller.signal.aborted
      ? existing
      : this.start(key, request);
    return this.consume(pending, signal);
  }

  /** Aborts active transports and removes all cached query results. */
  clear(): void {
    for (const pending of this.pending.values()) pending.controller.abort();
    this.pending.clear();
    this.cache.clear();
  }

  /** Starts one transport whose result can be shared by multiple consumers. */
  private start(key: string, request: Request): PendingQuery<Response> {
    const controller = new AbortController();
    const pending: PendingQuery<Response> = {
      controller,
      consumers: new Set(),
      promise: this.transport(request, controller.signal)
        .then(value => {
          if (!controller.signal.aborted) this.store(key, value);
          return value;
        })
        .finally(() => {
          if (this.pending.get(key) === pending) this.pending.delete(key);
        }),
    };
    this.pending.set(key, pending);
    return pending;
  }

  /** Tracks one consumer and cancels transport only after all consumers leave. */
  private consume(
    pending: PendingQuery<Response>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const token = Symbol("query-consumer");
    pending.consumers.add(token);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        pending.consumers.delete(token);
      };
      const onAbort = (): void => {
        finish();
        if (!pending.consumers.size) pending.controller.abort();
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, {once: true});
      pending.promise.then(
        value => {
          finish();
          resolve(value);
        },
        error => {
          finish();
          reject(error);
        },
      );
    });
  }

  /** Reads and refreshes one LRU entry when it remains inside its TTL. */
  private cached(key: string): Response | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  /** Inserts one result and evicts the least-recently-used excess entries. */
  private store(key: string, value: Response): void {
    this.cache.delete(key);
    this.cache.set(key, {value, expiresAt: this.now() + this.ttlMs});
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

/** Legacy metric queries are available only to the explicit read-only View. */
export class QueryStore extends ReadCache<MetricQueryRequest, ExperimentQueryResponse> {
  constructor(client: QueryClient, options: QueryStoreOptions = {}) {
    super((request, signal) => client.queryExperimentMetrics(request, signal), options);
  }
}

export class SnapshotStore {
  readonly latest: ReadCache<SnapshotLatestRequest, SnapshotLatestResponse>;
  readonly history: ReadCache<SnapshotHistoryRequest, SnapshotHistoryPage>;
  readonly query: ReadCache<SnapshotQueryRequest, SnapshotQueryResponse>;
  readonly diff: ReadCache<SnapshotDiffRequest, SnapshotDiffResponse>;

  constructor(client: Pick<ApiClient, "snapshotLatest" | "snapshotHistory" | "snapshotQuery" | "snapshotDiff">) {
    this.latest = new ReadCache((request, signal) => client.snapshotLatest(request, signal), {maxEntries: 8});
    this.history = new ReadCache((request, signal) => client.snapshotHistory(request, signal), {maxEntries: 8});
    this.query = new ReadCache((request, signal) => client.snapshotQuery(request, signal));
    this.diff = new ReadCache((request, signal) => client.snapshotDiff(request, signal), {ttlMs: 60_000, maxEntries: 16});
  }

  clear(): void {
    this.latest.clear();
    this.history.clear();
    this.query.clear();
    this.diff.clear();
  }
}

/** Creates the standard cancellation error used by browser fetch. */
function abortError(): DOMException {
  return new DOMException("Read was cancelled.", "AbortError");
}
