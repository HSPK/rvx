import type {Page} from "@playwright/test";
import type {JsonValue, StoredSnapshot} from "../src/domain/snapshots";
import type {
  ClusterGPUCapacityRow,
  ClusterGPUReport,
  ExperimentRun,
  ExperimentSource,
} from "../src/domain/types";

export const runs: ExperimentRun[] = [
  {
    id: "run-1",
    experiment_id: "experiment-1",
    name: "trial-1",
    status: "running",
    config_json: "{}",
    created_at_ns: 1_788_595_200_000_000_000,
    updated_at_ns: 1_788_595_211_000_000_000,
  },
  {
    id: "run-2",
    experiment_id: "experiment-2",
    name: "trial-2",
    status: "finished",
    config_json: "{}",
    created_at_ns: 1_788_590_200_000_000_000,
    updated_at_ns: 1_788_595_203_000_000_000,
  },
];

export const sources: ExperimentSource[] = [
  {
    id: "source-1",
    run_id: "run-1",
    attempt_id: "attempt-1",
    role: "hostmon",
    endpoint: "http://learner-0:9200",
    node_id: "node-a",
    rank: 0,
    state: "active",
    source_session_id: "session-1",
    last_success_at_ns: 1_788_595_211_000_000_000,
    last_error: null,
    scrape_interval_ms: 1000,
    timeout_ms: 5000,
    descriptor: null,
  },
];

const metrics = {
  "cpu/percent": 42,
  "memory/percent": 51,
  "disk/percent": 37,
  "gpu/percent": 78,
  "gpu/memory_percent": 64,
  "gpu/temperature_c": 71,
  "network/rx_mbps": 12,
  "network/tx_mbps": 3,
};

sources[0]!.descriptor = {
  protocol_version: 1, schema_version: 1, source_session_id: "session-1",
  project: "async-rl", experiment: "grpo", run_id: "run-1", attempt_id: "attempt-1",
  role: "hostmon", node_id: "node-a", pid: 4832, labels: {pool: "training"},
};
sources.push(
  {...sources[0]!, id: "source-3", role: "learner", source_session_id: "session-3", node_id: "node-b", descriptor: null},
  {...sources[0]!, id: "source-2", run_id: "run-2", role: "learner", state: "ended", source_session_id: "session-2", descriptor: null},
);

export const snapshots: StoredSnapshot[] = Array.from({length: 12}, (_, index) => {
  const value: JsonValue = [41, null, true, "pending", 43, null][index % 6]!;
  return {
    id: index + 1, run_id: "run-1", source_id: "source-1", source_session_id: index < 6 ? "session-1" : "session-restarted",
    sequence: index % 6, schema_version: 1,
    observed_at_ns: 1_788_595_200_000_000_000 + index * 1e9,
    ingested_at_ns: 1_788_600_000_000_000_000 + index * 1e9,
    axes: {optimizer_step: index * 10, policy_version: 2},
    state: {
      phase: index < 5 ? "warming" : "training",
      metrics: index === 2 ? {} : {"cpu/percent": value},
      progress: {step: index * 10, loss: 0.8 - index * 0.04},
      queue: {ready: 8, inflight: ["batch-72", "batch-73"]},
      workers: [{rank: 0, status: "busy", healthy: true}],
      note: "<img src=x onerror=window.__injected=true>",
      nullable: null,
    },
  };
});
snapshots.push(
  {...snapshots[11]!, id: 13, source_id: "source-3", source_session_id: "session-3", sequence: 0, state: {phase: "waiting", workers: [], queue: {ready: 0}}},
  ...Array.from({length: 4}, (_, index) => ({
    ...snapshots[index]!, id: 101 + index, run_id: "run-2", source_id: "source-2", source_session_id: "session-2",
    state: {...snapshots[index]!.state, phase: "finished", progress: {loss: 0.11, step: 800}},
  })),
);

function pointerValue(state: JsonValue, pointer: string): JsonValue | undefined {
  let value: JsonValue | undefined = state;
  for (const key of pointer.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as {[key: string]: JsonValue})[key];
  }
  return value;
}

const capacity: ClusterGPUCapacityRow = {
  queue: "queue-a",
  capacity_gpus: 64,
  allocated_gpus: 56,
  pending_gpus: 8,
  unallocated_gpus: 8,
  no_job_gpus: 0,
  no_job_node_equivalents: 0,
  capacity_cpus: 880,
  allocated_cpus: 700,
  free_cpus: 180,
  gpu_allocation: "56 / 64",
  utilization_percent: 87.5,
  cpu_allocation: "700 / 880",
};

const report: ClusterGPUReport = {
  gpus_per_node: 8,
  capacity: [capacity],
  total_capacity: {...capacity, queue: "TOTAL"},
  usage: [],
  workloads: [
    {
      queue: "queue-a",
      name: "training-job-001",
      status: "Mixed",
      submitter: "training-run",
      creator_id: "user-a",
      running_pods: 7,
      running_gpus: 56,
      running_gpu_nodes: 7,
      running_nodes: ["gpu-node-01", "gpu-node-02"],
      pending_pods: 1,
      pending_gpus: 8,
    },
  ],
};

export async function mockRvxApi(page: Page): Promise<void> {
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    switch (url.pathname) {
      case "/api/snapshots/latest": {
        const payload = request.postDataJSON();
        const latest = new Map<string, StoredSnapshot>();
        for (const snapshot of snapshots) {
          if (snapshot.run_id === payload.run_id && (!payload.source_ids?.length || payload.source_ids.includes(snapshot.source_id))) latest.set(snapshot.source_id, snapshot);
        }
        const remaining = [...latest.values()].sort((a, b) => a.source_id.localeCompare(b.source_id))
          .filter(snapshot => !payload.after_source_id || snapshot.source_id > payload.after_source_id);
        const page = remaining.slice(0, 1);
        return route.fulfill({json: {snapshots: page, next_source_id: remaining.length > 1 ? page[0]!.source_id : null}});
      }
      case "/api/snapshots/history": {
        const payload = request.postDataJSON();
        const remaining = snapshots.filter(snapshot =>
          snapshot.run_id === payload.run_id &&
          (!payload.source_ids?.length || payload.source_ids.includes(snapshot.source_id)) &&
          (payload.before_id == null || snapshot.id < payload.before_id) &&
          (payload.from == null || snapshot.observed_at_ns >= payload.from) &&
          (payload.to == null || snapshot.observed_at_ns <= payload.to))
          .sort((a, b) => b.id - a.id);
        const page = remaining.slice(0, Math.min(payload.limit ?? 100, 3));
        return route.fulfill({json: {snapshots: page, next_before_id: remaining.length > page.length ? page.at(-1)!.id : null}});
      }
      case "/api/snapshots/query": {
        const payload = request.postDataJSON();
        const series = [];
        for (const runId of payload.run_ids) {
          for (const sourceId of new Set(snapshots.filter(snapshot => snapshot.run_id === runId).map(snapshot => snapshot.source_id))) {
            if (payload.source_ids?.length && !payload.source_ids.includes(sourceId)) continue;
            const events = snapshots.filter(snapshot => {
              const value = payload.axis === "wall_time" ? snapshot.observed_at_ns : snapshot.axes[payload.axis];
              return snapshot.source_id === sourceId && value !== undefined &&
                (payload.from == null || value >= payload.from) &&
                (payload.to == null || value <= payload.to);
            });
            for (const path of payload.paths) series.push({
              run_id: runId, source_id: sourceId, path,
              source_session_ids: events.map(snapshot => snapshot.source_session_id),
              sequences: events.map(snapshot => snapshot.sequence),
              axes: events.map(snapshot => payload.axis === "wall_time" ? snapshot.observed_at_ns : snapshot.axes[payload.axis]),
              observed_at_ns: events.map(snapshot => snapshot.observed_at_ns),
              values: events.map(snapshot => {
                const value = pointerValue(snapshot.state, path);
                return typeof value === "number" ? value : null;
              }),
            });
          }
        }
        return route.fulfill({json: {axis: payload.axis ?? "wall_time", series}});
      }
      case "/api/snapshots/diff": {
        const payload = request.postDataJSON();
        return route.fulfill({json: {...payload, truncated: false, changes: [
          {path: "/phase", kind: "changed", before: "warming", after: "training"},
          {path: "/nullable", kind: "added", after: null},
          {path: "/removed", kind: "removed", before: null},
        ]}});
      }
      case "/api/experiments/stats":
        return route.fulfill({json: {
          snapshots: snapshots.length,
          projects: 1,
          experiments: 2,
          runs: runs.length,
          sources: sources.length,
          active_sources: 2,
          hot_points: 2,
          parquet_files: 0,
          wal_bytes: 1024,
          ingested_points: 2,
          compacted_values: 0,
          duplicate_points: 0,
          cursor_gaps: 0,
          scrape_failures: 0,
        }});
      case "/api/experiments/projects":
        return route.fulfill({json: {projects: [
          {id: "project-1", name: "async-rl", created_at_ns: 1},
        ]}});
      case "/api/experiments/experiments":
        return route.fulfill({json: {experiments: [
          {
            id: "experiment-1",
            project_id: "project-1",
            name: "grpo",
            created_at_ns: 1,
          },
          {
            id: "experiment-2",
            project_id: "project-1",
            name: "grpo-baseline",
            created_at_ns: 1_788_590_200_000_000_000,
          },
        ]}});
      case "/api/experiments/runs":
        return route.fulfill({json: {runs}});
      case "/api/experiments/sources":
        return route.fulfill({json: {sources}});
      case "/api/experiments/query": {
        const payload = request.postDataJSON();
        return route.fulfill({json: {
          run_id: payload.run_id,
          axis: payload.axis,
          series: (payload.metrics as string[]).map((metric, index) => ({
            metric,
            source_id: "source-1",
            source_session_ids: ["session-1", "session-1"],
            sequences: [1, 2],
            axes: payload.axis === "wall_time"
              ? [1_788_454_000_000_000_000, 1_788_454_010_000_000_000]
              : [1, 2],
            event_time_ns: [1, 2],
            values: [1 + index, 0.5 + index],
          })),
        }});
      }
      case "/api/experiments/query-summaries": {
        const payload = request.postDataJSON();
        return route.fulfill({json: {
          summaries: (payload.run_ids as string[]).map((runId, runIndex) => ({
            run_id: runId,
            values: Object.fromEntries(
              (payload.metrics as string[]).map((metric, metricIndex) => [
                metric,
                runIndex + metricIndex + 0.5,
              ]),
            ),
          })),
        }});
      }
      case "/api/status":
        return route.fulfill({json: {
          host: "test-host",
          version: "0.1.0",
          updated_at: Date.now() / 1000,
          metrics,
          fields: {
            k8s_stopped_tasks: "(none)",
            k8s_stopped_task_details: "(none)",
            k8s_failed_tasks: "(none)",
          },
          websocket_clients: 0,
          websocket_inactivity_timeout_seconds: 30,
        }});
      case "/api/catalog":
        return route.fulfill({json: {
          seconds: Number(url.searchParams.get("seconds")),
          metrics: Object.entries(metrics).map(([name, value]) => ({
            name,
            metadata: {
              label: name,
              unit: name.endsWith("percent") ? "%" : "",
              color: "#4ea1d3",
            },
            current: value,
            minimum: value - 1,
            maximum: value + 1,
            average: value,
            p95: value + 0.8,
            samples: 60,
          })),
        }});
      case "/api/collectors":
        return route.fulfill({json: {collectors: [{
          name: "cpu",
          enabled: true,
          required: true,
          refresh_seconds: 10,
          deadline_seconds: 2,
          max_stale_seconds: 0,
          last_success_at: Date.now() / 1000,
          last_failure_at: null,
          last_error: null,
          state: "up",
          duration: 1,
          failures: 0,
          options: {},
        }]}});
      case "/api/rules":
        return route.fulfill({json: {rules: [{
          alert: "high-cpu",
          expr: "cpu.percent >= 90",
          level: "warning",
          title: "High CPU",
          message: "CPU is high",
          enabled: true,
        }]}});
      case "/api/plugins/cluster_gpu_usage":
        return route.fulfill({json: {
          name: "cluster_gpu_usage",
          updated_at: Date.now() / 1000,
          schema_version: null,
          refresh_seconds: 60,
          refresh_after_seconds: 60,
          document: report,
        }});
      default:
        return route.fulfill({status: 404, json: {error: "Unmocked API route"}});
    }
  });
}
