"""Bounded workload and Linux resource probes shared by local simulations."""
from pathlib import Path
import os
import random
import threading
import time
import traceback


def percentiles(values):
    ordered = sorted(values)
    if not ordered:
        return {"count": 0}
    return {
        "count": len(ordered),
        **{key: round(ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction))], 3)
           for key, fraction in (("p50_ms", .5), ("p95_ms", .95), ("p99_ms", .99), ("max_ms", 1))},
    }


class RateSchedule:
    def __init__(self, start, interval):
        self.next_due = start
        self.interval = interval

    def next(self, now):
        skipped = max(0, int((now - self.next_due) / self.interval))
        self.next_due += skipped * self.interval
        due = self.next_due
        self.next_due += self.interval
        return due, skipped


class ProcessSampler:
    def __init__(self, pid, files=None):
        self.pid = pid
        self.started = time.monotonic()
        self.samples = []
        self.errors = []
        self.stopped = threading.Event()
        self.finished = False
        self.files = dict(files or {})
        self.thread = threading.Thread(target=self._run)
        self._sample()
        self.thread.start()

    def _sample(self):
        try:
            root = Path(f"/proc/{self.pid}")
            status = dict(line.split(":", 1) for line in (root / "status").read_text().splitlines())
            stat = (root / "stat").read_text().rsplit(") ", 1)[1].split()
            io = dict(line.split(":", 1) for line in (root / "io").read_text().splitlines())
            pressure = {
                line.split()[0]: dict(item.split("=") for item in line.split()[1:])
                for line in Path("/proc/pressure/io").read_text().splitlines()
            }
            file_bytes = {}
            for name, path in self.files.items():
                try:
                    file_bytes[name] = Path(path).stat().st_size
                except FileNotFoundError:
                    file_bytes[name] = 0
            self.samples.append({
                "seconds": round(time.monotonic() - self.started, 3),
                "rss_mib": int(status["VmRSS"].split()[0]) / 1024,
                "hwm_mib": int(status["VmHWM"].split()[0]) / 1024,
                "threads": int(status["Threads"]),
                "cpu_seconds": (int(stat[11]) + int(stat[12])) / os.sysconf("SC_CLK_TCK"),
                "read_bytes": int(io["read_bytes"]), "write_bytes": int(io["write_bytes"]),
                "host_io_full_avg10_percent": float(pressure["full"]["avg10"]),
                "host_io_some_avg10_percent": float(pressure["some"]["avg10"]),
                "file_bytes": file_bytes,
            })
        except (OSError, KeyError, ValueError):
            self.errors.append(traceback.format_exc())
            self.stopped.set()

    def _run(self):
        while not self.stopped.wait(.5):
            self._sample()

    def stop(self):
        if not self.finished:
            self.stopped.set()
            self.thread.join(2)
            if self.thread.is_alive():
                raise AssertionError("resource sampler did not stop")
            self._sample()
            self.finished = True
        if not self.samples:
            return {"errors": self.errors}
        first, last = self.samples[0], self.samples[-1]
        elapsed = last["seconds"] - first["seconds"]
        cpu = last["cpu_seconds"] - first["cpu_seconds"]
        return {
            "sampled_peak_rss_mib": round(max(s["rss_mib"] for s in self.samples), 2),
            "process_lifetime_hwm_mib": round(max(s["hwm_mib"] for s in self.samples), 2),
            "max_threads": max(s["threads"] for s in self.samples),
            "cpu_seconds": round(cpu, 3),
            "average_cpu_cores": round(cpu / elapsed, 3) if elapsed else 0,
            "read_bytes": last["read_bytes"] - first["read_bytes"],
            "write_bytes": last["write_bytes"] - first["write_bytes"],
            "max_host_io_full_avg10_percent": max(s["host_io_full_avg10_percent"] for s in self.samples),
            "file_sampled_peak_bytes": {
                name: max(s["file_bytes"][name] for s in self.samples) for name in self.files
            },
            "timeline": self.samples, "errors": self.errors,
        }


class ReadLoad:
    def __init__(self, lab, run_ids, workers, rate=0, think_time=.01,
                 source_ids=(), metric_path="/metrics/loss"):
        self.lab = lab
        self.run_ids = run_ids
        self.workers = workers
        self.rate = rate
        self.think_time = think_time
        self.source_ids = list(source_ids)
        self.metric_path = metric_path
        self.started = time.monotonic()
        self.client_cpu_start = time.process_time()
        self.stopped = threading.Event()
        self.results = {}
        self.threads = []
        self.summary = None
        for number in range(workers):
            thread = threading.Thread(target=self._read, args=(number,))
            thread.start()
            self.threads.append(thread)

    def _metric_available(self, catalog, run):
        return any(
            metric["path"] == self.metric_path and (
                not self.source_ids or any(
                    source["run_id"] == run and source["source_id"] in self.source_ids
                    for source in metric["sources"]
                )
            )
            for metric in catalog["metrics"]
        )

    def _read(self, number):
        rng = random.Random(1729 + number)
        indexed = set()
        result = {"latency": {}, "scheduled_latency": {}, "skipped": 0, "attempted": 0,
                  "errors": [], "start_lag_ms": []}
        self.results[number] = result
        schedule = RateSchedule(self.started + number / self.rate, self.workers / self.rate) if self.rate else None
        try:
            while not self.stopped.is_set():
                lag = 0
                if schedule:
                    due, skipped = schedule.next(time.monotonic())
                    result["skipped"] += skipped
                    if self.stopped.wait(max(0, due - time.monotonic())):
                        break
                    lag = max(0, time.monotonic() - due) * 1000
                    result["start_lag_ms"].append(lag)
                run = rng.choice(self.run_ids)
                path = rng.choice(["/api/snapshots/latest", "/api/snapshots/history",
                                   "/api/charts/catalog", "/api/snapshots/query"])
                if path.endswith("query") and run not in indexed:
                    path = "/api/charts/catalog"
                if path.endswith("query"):
                    payload = {"run_ids": [run], "paths": [self.metric_path], "axis": "step", "max_points": 64}
                elif path.endswith("catalog"):
                    payload = {"run_ids": [run]}
                else:
                    payload = {"run_id": run, "limit": 32}
                if self.source_ids and not path.endswith("catalog"):
                    payload["source_ids"] = self.source_ids
                started = time.perf_counter()
                result["attempted"] += 1
                value = self.lab.request(path, payload)
                elapsed = (time.perf_counter() - started) * 1000
                result["latency"].setdefault(path, []).append(elapsed)
                if schedule:
                    result["scheduled_latency"].setdefault(path, []).append(elapsed + lag)
                if path.endswith("catalog"):
                    if self._metric_available(value, run):
                        indexed.add(run)
                elif path.endswith("latest"):
                    if any(s["state"].get("tracker", {}).get("kind") == "event" for s in value["snapshots"]):
                        raise AssertionError("event contaminated latest")
                elif path.endswith("query"):
                    for series in value["series"]:
                        if len(series["axes"]) != len(series["values"]) or len(series["axes"]) > 64:
                            raise AssertionError("numeric query returned inconsistent or unbounded series")
                if not schedule:
                    self.stopped.wait(self.think_time)
        except Exception:
            result["errors"].append(traceback.format_exc())

    def stop(self):
        if self.summary is not None:
            return self.summary
        self.stopped.set()
        offered_seconds = time.monotonic() - self.started
        for thread in self.threads:
            thread.join(15)
            if thread.is_alive():
                raise AssertionError("reader did not stop")
        elapsed = time.monotonic() - self.started
        latency = {}
        scheduled_latency = {}
        lag = []
        for result in self.results.values():
            for path, values in result["latency"].items():
                latency.setdefault(path, []).extend(values)
            for path, values in result["scheduled_latency"].items():
                scheduled_latency.setdefault(path, []).extend(values)
            lag.extend(result["start_lag_ms"])
        completed = sum(map(len, latency.values()))
        self.summary = {
            "reader_threads": self.workers, "target_requests_per_second": self.rate or None,
            "think_time_ms": self.think_time * 1000 if not self.rate else 0,
            "source_ids": self.source_ids, "metric_path": self.metric_path,
            "offered_seconds": round(offered_seconds, 3),
            "elapsed_including_drain_seconds": round(elapsed, 3),
            "attempted": sum(r["attempted"] for r in self.results.values()),
            "completed": completed, "completed_per_second": round(completed / elapsed, 3),
            "skipped_arrivals": sum(r["skipped"] for r in self.results.values()),
            "start_lag": percentiles(lag),
            "latency": {path: percentiles(values) for path, values in latency.items()},
            "scheduled_latency": {path: percentiles(values) for path, values in scheduled_latency.items()},
            "errors": [error for r in self.results.values() for error in r["errors"]],
            "client_cpu_seconds": round(time.process_time() - self.client_cpu_start, 3),
        }
        return self.summary
