import {ApiClient} from "../core/api-client";
import {readWeight} from "../core/read-weight";
import type {ChartCatalog, SnapshotQueryRequest, SnapshotQueryResponse} from "../domain/snapshots";
import type {SummaryRequest, SummaryResponse, TableCatalogRequest, TableCatalogResponse, TableRowsRequest, TableRowsResponse} from "../domain/tables";
import type {ExperimentSource} from "../domain/types";
import type {SnapshotAggregateRequest, SnapshotAggregateResponse, SnapshotRecordsRequest, SnapshotRecordsResponse} from "../domain/snapshot-views";

interface Cached {value: unknown; bytes: number; expires: number}
interface Pending {controller: AbortController; promise: Promise<unknown>; users: number}

/** Share bounded metadata, numeric projections and table reads without fetching raw snapshots. */
export class MetricCatalogQueryCoordinator {
  private cache = new Map<string, Cached>();
  private pending = new Map<string, Pending>();
  private bytes = 0;
  private active = 0;
  private queue: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval>;
  /** Reclaim expired retained responses even when no further reads arrive. */
  constructor(readonly api = new ApiClient(), private budget = 32 * 1024 * 1024, private ttl = 15_000) {
    this.timer = setInterval(() => this.prune(), 15_000);
  }
  /** Canonicalize run selection so equivalent discovery requests share one read. */
  catalog(runIds: string[], signal: AbortSignal, fresh = false): Promise<ChartCatalog> {
    const ids = [...runIds].sort();
    return this.read(`catalog:${JSON.stringify(ids)}`, s => this.api.catalog(ids, s), signal, fresh);
  }
  /** Deduplicate bounded projections independently of caller ordering. */
  query(request: SnapshotQueryRequest, signal: AbortSignal, fresh = false): Promise<SnapshotQueryResponse> {
    const body = {...request, run_ids: [...request.run_ids].sort(), paths: [...request.paths].sort(),
      ...(request.source_ids ? {source_ids: [...request.source_ids].sort()} : {}), max_points: Math.min(request.max_points ?? 1600, 2000)};
    return this.read(`query:${JSON.stringify(body)}`, s => this.api.query(body, s), signal, fresh);
  }
  /** Share bounded authoritative summary reads without deriving statistics from curves. */
  summary(body: SummaryRequest, signal: AbortSignal, fresh = false): Promise<SummaryResponse> {
    return this.read(`summary:${JSON.stringify(body)}`, s => this.api.tableSummary(body, s), signal, fresh);
  }
  /** Deduplicate current collection discovery across editors and visible tables. */
  tables(body: TableCatalogRequest, signal: AbortSignal, fresh = false): Promise<TableCatalogResponse> {
    return this.read(`tables:${JSON.stringify(body)}`, s => this.api.tableCatalog(body, s), signal, fresh);
  }
  /** Include retry-scoped pins in cache identity without pinning subsequent latest refreshes. */
  rows(body: TableRowsRequest, signal: AbortSignal, fresh = false): Promise<TableRowsResponse> {
    return this.read(`rows:${JSON.stringify(body)}`, s => this.api.tableRows(body, s), signal, fresh);
  }
  /** Keep record-page identities and optional immutable pins in the shared bounded cache. */
  records(request: SnapshotRecordsRequest, signal: AbortSignal, fresh = false): Promise<SnapshotRecordsResponse> {
    const body = {...request, run_ids: [...request.run_ids].sort(), ...(request.source_ids ? {source_ids: [...request.source_ids].sort()} : {})};
    return this.read(`records:${JSON.stringify(body)}`, s => this.api.snapshotRecords(body, s), signal, fresh);
  }
  /** Share full-dataset aggregates across visual panels without recomputing from browser pages. */
  aggregate(request: SnapshotAggregateRequest, signal: AbortSignal, fresh = false): Promise<SnapshotAggregateResponse> {
    const body = {...request, run_ids: [...request.run_ids].sort(), ...(request.source_ids ? {source_ids: [...request.source_ids].sort()} : {})};
    return this.read(`aggregate:${JSON.stringify(body)}`, s => this.api.snapshotAggregate(body, s), signal, fresh);
  }
  /** Resolve registered reporters that may legitimately have no indexed metric metadata yet. */
  sources(runId: string, signal: AbortSignal): Promise<ExperimentSource[]> {
    return this.read(`sources:${runId}`, s => this.api.sources(runId, s), signal);
  }
  /** Share in-flight reads while keeping each consumer's cancellation independent. */
  async read<T>(key: string, loader: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, fresh = false): Promise<T> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.prune();
    const cached = this.cache.get(key);
    if (!fresh && cached) {
      this.cache.delete(key); this.cache.set(key, cached);
      return cached.value as T;
    }
    let pending = this.pending.get(key);
    if (pending?.controller.signal.aborted) pending = undefined;
    if (!pending) {
      const controller = new AbortController();
      const entry: Pending = {controller, users: 0, promise: Promise.resolve()};
      entry.promise = this.schedule(() => loader(controller.signal), controller.signal).then(value => {
        if (!controller.signal.aborted) this.put(key, value);
        return value;
      }).finally(() => {if (this.pending.get(key) === entry) this.pending.delete(key);});
      pending = entry;
      this.pending.set(key, entry);
    }
    pending.users++;
    const entry = pending;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const release = (): void => {
        done = true; signal.removeEventListener("abort", abort);
        if (--entry.users === 0) entry.controller.abort();
      };
      const abort = (): void => {if (!done) {release(); reject(new DOMException("Aborted", "AbortError"));}};
      signal.addEventListener("abort", abort, {once: true});
      entry.promise.then(value => {if (!done) {release(); resolve(value as T);}}, error => {if (!done) {release(); reject(error);}});
    });
  }
  /** Limit concurrent transports and remove cancelled work before it reaches the network. */
  private schedule<T>(load: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {reject(new DOMException("Aborted", "AbortError")); return;}
        this.active++;
        load().then(resolve, reject).finally(() => {this.active--; this.queue.shift()?.();});
      };
      const abort = (): void => {
        this.queue = this.queue.filter(item => item !== start);
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (this.active < 2) start();
      else {this.queue.push(start); signal.addEventListener("abort", abort, {once: true});}
    });
  }
  /** Evict least-recently-used responses until both entry and byte budgets permit retention. */
  private put(key: string, value: unknown): void {
    const previous = this.cache.get(key);
    if (previous) {this.bytes -= previous.bytes; this.cache.delete(key);}
    const bytes = readWeight(value);
    if (bytes > this.budget) return;
    while (this.cache.size >= 64 || this.bytes + bytes > this.budget) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
    }
    this.cache.set(key, {value, bytes, expires: Date.now() + this.ttl}); this.bytes += bytes;
  }
  /** Release expired response references and their accounted bytes together. */
  private prune(): void {
    for (const [key, value] of this.cache) {
      if (value.expires <= Date.now()) {this.bytes -= value.bytes; this.cache.delete(key);}
    }
  }
  /** Report live cache accounting after removing expired entries. */
  get retainedBytes(): number {this.prune(); return this.bytes;}
  /** Stop eviction work and abort all queued or active reads on application teardown. */
  destroy(): void {
    clearInterval(this.timer);
    for (const pending of this.pending.values()) pending.controller.abort();
    this.pending.clear(); this.cache.clear(); this.bytes = 0;
  }
}
