"""Reproducible, opt-in CPU-local system simulations; never use a live RVX directory."""
from __future__ import annotations

import argparse
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, closing
import hashlib
import json
import multiprocessing as mp
import os
from pathlib import Path
import random
import resource
import select
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import warnings
from urllib.parse import urlsplit

from rvx import Source, SnapshotEvent, _native, tracker
from tests.http_api import api_request
from tests.performance import ProcessSampler, ReadLoad, percentiles


ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("RVXD_BINARY", ROOT / "target/release/rvxd")).resolve()


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def wait_until(predicate, deadline, description, interval=.025):
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise AssertionError(f"timed out waiting for {description}")


def rss_mib(pid):
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    except FileNotFoundError:
        return 0.0
    return 0.0


class Lab:
    def __init__(self, root, concurrency=16):
        self.root = root
        self.concurrency = concurrency
        self.process = None
        self.log = None
        self.base = ""
        self.peak_rss_mib = 0.0
        self.request_failures = []
        self.start()

    def start(self):
        self.log = (self.root / "daemon.log").open("a+")
        try:
            self._start()
        except BaseException:
            try:
                if self.process is not None:
                    if self.process.poll() is None:
                        self.process.kill()
                    self.process.communicate(timeout=5)
            finally:
                self.process = None
                self.log.close()
                self.log = None
            raise

    def _start(self):
        ui = self.root / "ui"
        ui.mkdir(exist_ok=True)
        (ui / "index.html").write_text("<html><title>RVX simulation</title></html>")
        environment = {**os.environ, "TOKIO_WORKER_THREADS": "4"}
        environment.pop("RVX_API_TOKEN", None)
        environment.pop("RVX_PUBLIC_ORIGIN", None)
        self.process = subprocess.Popen(
            [str(BINARY), "--data-dir", str(self.root / "data"), "--listen", "127.0.0.1:0",
             "--ui-dir", str(ui), "--scrape-concurrency", str(self.concurrency)],
            stdout=subprocess.PIPE, stderr=self.log, text=True, env=environment,
        )
        require(bool(select.select([self.process.stdout], [], [], 15)[0]), "daemon readiness timeout")
        line = self.process.stdout.readline().strip()
        require(line.startswith("rvxd listening on http://"), f"invalid readiness: {line}")
        self.base = line.removeprefix("rvxd listening on ")
        self.request("/api/experiments/stats")

    def request(self, path, payload=None, method=None):
        self.peak_rss_mib = max(self.peak_rss_mib, rss_mib(self.process.pid))
        start = time.monotonic()
        try:
            return api_request(self.base, path, method=method or ("GET" if payload is None else "POST"),
                               payload=payload, timeout=10)
        except Exception as error:
            self.request_failures.append({
                "path": path, "elapsed_seconds": round(time.monotonic() - start, 3),
                "error": str(error),
            })
            raise

    def hierarchy(self, count):
        project = self.request("/api/experiments/projects", {"name": "simulation"})
        experiment = self.request("/api/experiments/experiments",
                                  {"project_id": project["id"], "name": "training"})
        return [self.request("/api/experiments/runs",
                             {"experiment_id": experiment["id"], "name": f"run-{i}", "config": {"seed": i}})
                for i in range(count)]

    def register(self, run, source, role="worker", interval=100, timeout=750):
        return self.request("/api/experiments/sources", {
            "run_id": run, "attempt_id": "attempt-1", "role": role,
            "endpoint": source, "scrape_interval_ms": interval, "timeout_ms": timeout,
        })

    def stop(self, crash=False):
        if self.process is None:
            return
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGKILL if crash else signal.SIGTERM)
        try:
            try:
                stdout, _ = self.process.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.communicate(timeout=5)
                raise AssertionError("daemon exceeded shutdown deadline")
            code = self.process.returncode
        finally:
            self.process = None
            self.log.close()
            self.log = None
        require(code == (-signal.SIGKILL if crash else 0), f"unexpected daemon exit {code}: {stdout}")

    def close(self):
        self.stop()


def metrics(index, step, payload_kib=0, numeric_fields=0):
    data = {
        "loss": float(index * 10000 + step),
        "step": step,
        "exact": 2**64 - 1,
        "unicode": "训练",
        "rows": [{"id": row, "status": "active", "value": step + row} for row in range(4)],
        "a/b~c": step,
    }
    if step % 3 == 0:
        data["nullable"] = None
    elif step % 3 == 1:
        data["nullable"] = 0
    if payload_kib:
        data["payload"] = "x" * (payload_kib * 1024)
    if numeric_fields:
        data["wide"] = {}
        for field in range(numeric_fields):
            data["wide"].setdefault(f"group-{field // 64}", {})[f"value-{field}"] = step + field
    return data


def producer_buffer_limits(steps, payload_kib=0, numeric_fields=0):
    capacity = steps + (steps + 63) // 64 + (steps + 127) // 128 + 1
    # Native retention accounts for tree nodes, including both metrics and summary.
    return capacity, max(64 * 1024 * 1024,
                         capacity * (32768 + payload_kib * 2048 + numeric_fields * 512))


def producer_worker(connection, assignments, steps, deadline_seconds, payload_kib=0, numeric_fields=0):
    with ExitStack() as cleanup:
        cleanup.callback(connection.close)
        sources = []
        try:
            _produce(connection, assignments, steps, deadline_seconds, sources, cleanup,
                     payload_kib, numeric_fields)
        except Exception:
            connection.send(("error", traceback.format_exc()))
            raise


def _produce(connection, assignments, steps, deadline_seconds, sources, cleanup, payload_kib, numeric_fields):
    capacity, buffer_bytes = producer_buffer_limits(steps, payload_kib, numeric_fields)
    ready = []
    for index, run in assignments:
        if index % 2:
            source = tracker.Run(
                project="simulation", experiment="training", name=f"source-{index}",
                run_id=run, role="worker", rank=index, serve=True,
                capacity=capacity, max_buffer_bytes=buffer_bytes,
                history_steps=64, watchdog_interval_ms=0,
                config={"source_index": index},
            )
        else:
            source = Source(project="simulation", experiment="training",
                            run_id=run, role="worker", rank=index,
                            capacity=capacity, max_buffer_bytes=buffer_bytes).serve()
        sources.append((index, run, source))
        cleanup.callback(source.close)
        ready.append({"index": index, "run": run, "endpoint": source.endpoint,
                      "session": source.source_session_id})
    connection.send(("ready", ready))
    require(connection.poll(deadline_seconds), "no start signal")
    require(connection.recv() == "start", "invalid producer command")
    timings = []
    for step in range(steps):
        for index, _, source in sources:
            start = time.perf_counter()
            data = metrics(index, step, payload_kib, numeric_fields)
            observed = 1_800_000_000_000_000_000 + step * 1_000_000 + index
            if isinstance(source, tracker.Run):
                source.log(data, step=step, commit=True, observed_at_ns=observed)
                if step % 64 == 0:
                    source.alert("progress", f"source={index} step={step}", level="info",
                                 observed_at_ns=observed + 1000)
                if step % 128 == 0:
                    source.use_artifact(f"sim://dataset/{index}", name="dataset",
                                        digest=f"digest-{index}", observed_at_ns=observed + 2000)
            else:
                source.capture({"metrics": data}, axes={"step": step}, observed_at_ns=observed)
            timings.append((time.perf_counter() - start) * 1000)
        if step % 16 == 0:
            time.sleep(.002)
    results = []
    for index, run, source in sources:
        if isinstance(source, tracker.Run):
            source.finish()
            count = source.info()["accepted_next_sequence"]
        else:
            count = source.seal()
        retained = json.loads(source.history_bytes(after=0, limit=1))
        require(retained["oldest_sequence"] == 0,
                f"fixture buffer evicted observations: source={index} oldest={retained['oldest_sequence']}")
        latest = json.loads(source.latest_bytes())
        results.append({"index": index, "run": run, "session": source.source_session_id,
                        "count": count, "latest_sequence": latest["sequence"]})
    connection.send(("done", {
        "sources": results, "log_latency": percentiles(timings),
        "peak_rss_mib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
    }))
    require(connection.poll(deadline_seconds), "consumer did not release producers")
    require(connection.recv() == "close", "invalid producer cleanup command")


def load_campaign(root, source_count, steps, workers, timeout, concurrency, reader_count, measurements,
                  read_rps=0, payload_kib=0, numeric_fields=0, read_phase_seconds=0):
    lab = Lab(root, concurrency=concurrency)
    processes = []
    pipes = []
    readers = None
    sampler = None
    measurements.update(sources=source_count, runs=4, producer_processes=workers,
                        scrape_concurrency=concurrency, reader_threads=reader_count,
                        observations=source_count * steps, payload_kib=payload_kib,
                        extra_numeric_fields=numeric_fields, progress_poll_interval_seconds=1)
    try:
        runs = lab.hierarchy(4)
        context = mp.get_context("spawn")
        assignments = [(i, runs[i % len(runs)]["id"]) for i in range(source_count)]
        for worker in range(workers):
            parent, child = context.Pipe()
            process = context.Process(target=producer_worker,
                args=(child, assignments[worker::workers], steps, timeout + read_phase_seconds * 3,
                      payload_kib, numeric_fields), daemon=True)
            process.start()
            child.close()
            processes.append(process)
            pipes.append(parent)
        ready = []
        deadline = time.monotonic() + timeout
        for pipe in pipes:
            require(pipe.poll(max(0, deadline - time.monotonic())), "producer startup timeout")
            kind, value = pipe.recv()
            require(kind == "ready", f"producer startup failed: {value}")
            ready.extend(value)
        registered = {}
        for item in ready:
            record = lab.register(item["run"], item["endpoint"])
            registered[item["index"]] = record["id"]

        sampler = ProcessSampler(lab.process.pid)
        readers = ReadLoad(lab, [run["id"] for run in runs], reader_count, read_rps)
        start = time.monotonic()
        for pipe in pipes:
            pipe.send("start")
        expected = []
        worker_stats = []
        for pipe in pipes:
            require(pipe.poll(max(0, deadline - time.monotonic())), "producer completion timeout")
            kind, value = pipe.recv()
            require(kind == "done", f"producer failed: {value}")
            expected.extend(value["sources"])
            worker_stats.append({key: value[key] for key in ("log_latency", "peak_rss_mib")})
        total = sum(item["count"] for item in expected)
        measurements.update(expected_records=total, workers=worker_stats)

        def caught_up():
            stats = lab.request("/api/experiments/stats")
            measurements["last_ingest_stats"] = stats
            require(stats["cursor_gaps"] == 0, f"load cannot complete after retention gaps: {stats}")
            return stats["snapshots"] == total

        wait_until(caught_up, deadline, f"{total} persisted records", interval=1)
        elapsed = time.monotonic() - start
        measurements["mixed_reads"] = readers.stop()
        measurements["ingest_resources"] = sampler.stop()
        require(not measurements["mixed_reads"]["errors"], str(measurements["mixed_reads"]["errors"]))
        require(not measurements["ingest_resources"]["errors"], str(measurements["ingest_resources"]["errors"]))
        if read_phase_seconds:
            for source_id in registered.values():
                lab.request(f"/api/experiments/sources/{source_id}", {"state": "ended"}, method="PATCH")
            wait_until(lambda: lab.request("/api/experiments/stats")["active_sources"] == 0,
                       time.monotonic() + 30, "quiescent sources")
            lab.stop()
            lab.start()
        for item in expected:
            source_id = registered[item["index"]]
            ack = lab.request("/api/snapshots/ack", {
                "run_id": item["run"], "source_id": source_id,
                "source_session_id": item["session"], "next_sequence": item["count"],
            })
            require(ack["complete"] and not ack["has_gaps"], f"missing durable prefix: {ack}")
            latest = lab.request("/api/snapshots/latest", {"run_id": item["run"], "source_ids": [source_id]})["snapshots"][0]
            require(latest["state"]["metrics"] == metrics(item["index"], steps-1, payload_kib, numeric_fields),
                    "latest state mismatch")
            require(latest["sequence"] == item["latest_sequence"], "latest observation cursor mismatch")
            fields = {"/metrics/loss": item["index"] * 10000}
            if numeric_fields:
                fields.update({f"/metrics/wide/group-{field // 64}/value-{field}": field
                               for field in {0, numeric_fields // 2, numeric_fields - 1}})
            query = lab.request("/api/snapshots/query", {
                "run_ids": [item["run"]], "source_ids": [source_id],
                "paths": list(fields), "axis": "step", "max_points": steps,
            })["series"]
            require({series["path"] for series in query} == set(fields), "missing indexed metric series")
            for series in query:
                require(series["axes"] == list(range(steps)), "event pollution or skipped metric steps")
                require(series["values"] == [float(fields[series["path"]] + n) for n in range(steps)],
                        "query mismatch")
        stats = lab.request("/api/experiments/stats")
        require(stats["cursor_gaps"] == 0, f"unexpected cursor gaps: {stats}")
        peak = lab.peak_rss_mib
        measurements.update({
            "persisted_records": total, "elapsed_ingest_seconds": round(elapsed, 3),
            "records_per_second": round(total / elapsed, 1),
            "scrape_failures": stats["scrape_failures"], "cursor_gaps": stats["cursor_gaps"],
        })
        if read_phase_seconds:
            measurements["quiescent_reads"] = []
            for count in (1, 4, 8):
                phase_sampler = ProcessSampler(lab.process.pid)
                phase_readers = ReadLoad(lab, [run["id"] for run in runs], count, think_time=0)
                try:
                    time.sleep(read_phase_seconds)
                finally:
                    phase = phase_readers.stop()
                    phase["resources"] = phase_sampler.stop()
                    measurements["quiescent_reads"].append(phase)
                require(not phase["errors"] and not phase["resources"]["errors"], str(phase))
        lab.stop()
        with closing(sqlite3.connect(f"file:{root / 'data/snapshots.db'}?mode=ro", uri=True)) as database:
            count, encoded_bytes, max_bytes = database.execute(
                "SELECT COUNT(*), SUM(LENGTH(CAST(snapshot_json AS BLOB))), "
                "MAX(LENGTH(CAST(snapshot_json AS BLOB))) FROM snapshots").fetchone()
            require(count == total, "offline record count mismatch")
            measurements["dataset"] = {
                "snapshot_json_bytes": encoded_bytes, "max_snapshot_json_bytes": max_bytes,
                "indexed_values": database.execute("SELECT COUNT(*) FROM chart_values").fetchone()[0],
                "source_field_pairs": database.execute("SELECT COUNT(*) FROM chart_fields").fetchone()[0],
            }
            measurements["snapshot_json_mib_per_second"] = round(encoded_bytes / 1024**2 / elapsed, 3)
        lab.start()
        require(lab.request("/api/experiments/stats")["snapshots"] == total, "restart changed record count")
        measurements.update({
            "persisted_records": total,
            "elapsed_ingest_seconds": round(elapsed, 3), "records_per_second": round(total / elapsed, 1),
            "daemon_sampled_peak_rss_mib": round(peak, 2),
            "scrape_failures": stats["scrape_failures"], "cursor_gaps": stats["cursor_gaps"],
        })
        return measurements
    finally:
        if readers is not None:
            measurements["mixed_reads"] = readers.stop()
        if sampler is not None:
            measurements["ingest_resources"] = sampler.stop()
        measurements.update({
            "daemon_sampled_peak_rss_mib": round(lab.peak_rss_mib, 2),
            "request_failures": lab.request_failures,
        })
        for pipe in pipes:
            try:
                pipe.send("close")
            except (BrokenPipeError, EOFError):
                pass
        for process in processes:
            process.join(10)
            if process.is_alive():
                process.terminate()
                process.join(5)
            if process.is_alive():
                process.kill()
                process.join(5)
        for pipe in pipes:
            pipe.close()
        lab.close()


def recovery_campaign(root, steps, timeout):
    lab = Lab(root, concurrency=4)
    try:
        run = lab.hierarchy(1)[0]["id"]
        with ExitStack() as owners:
            sources = [owners.enter_context(Source(project="simulation", experiment="training",
                        run_id=run, role="worker", rank=i, capacity=steps + 64)).serve()
                       for i in range(8)]
            registrations = [lab.register(run, source.endpoint) for source in sources]
            for source in sources:
                for start in range(0, steps, 64):
                    source.capture_batch([SnapshotEvent({"metrics": metrics(0, step)},
                        axes={"step": step}) for step in range(start, min(start+64, steps))])
            first_count = wait_until(
                lambda: lab.request("/api/experiments/stats")["snapshots"],
                time.monotonic() + timeout, "first persisted batch")
            lab.stop(crash=True)
            lab.start()
            wait_until(lambda: lab.request("/api/experiments/stats")["snapshots"] == steps * len(sources),
                       time.monotonic() + timeout, "crash recovery backlog")
            for source, registration in zip(sources, registrations):
                ack = lab.request("/api/snapshots/ack", {
                    "run_id": run, "source_id": registration["id"],
                    "source_session_id": source.source_session_id, "next_sequence": steps,
                })
                require(ack["complete"], "crash recovery lost or duplicated records")
            original = sources[0]
            port = urlsplit(original.endpoint).port
            session = original.source_session_id
            original.stop_serving()
            original.capture({"metrics": metrics(0, steps)}, axes={"step": steps})
            wait_until(lambda: lab.request("/api/experiments/stats")["scrape_failures"] > 0,
                       time.monotonic()+timeout, "expected disconnected-source failure")
            original.serve(port=port)
            wait_until(lambda: lab.request("/api/experiments/stats")["snapshots"] == steps*8+1,
                       time.monotonic()+timeout, "same-session reconnect")
            original.close()
            with Source(project="simulation", experiment="training", run_id=run, role="worker") as replacement:
                replacement.serve(port=port)
                replacement.capture({"metrics": {"fresh_session": True}})
                require(replacement.source_session_id != session, "producer restart reused session")
                wait_until(lambda: lab.request("/api/experiments/stats")["snapshots"] == steps*8+2,
                           time.monotonic()+timeout, "fresh-session capture")
                latest = lab.request("/api/snapshots/latest", {"run_id": run,
                    "source_ids": [registrations[0]["id"]]})["snapshots"][0]
                require(latest["source_session_id"] == replacement.source_session_id, "head retained retired session")
            with Source(project="simulation", experiment="training", run_id=run, role="worker", capacity=4) as evicted:
                evicted.serve()
                for i in range(20):
                    evicted.capture({"metrics": {"step": i}})
                registered = lab.register(run, evicted.endpoint)
                wait_until(lambda: lab.request("/api/experiments/stats")["cursor_gaps"] > 0,
                           time.monotonic()+timeout, "recorded retention gap")
                ack = lab.request("/api/snapshots/ack", {"run_id": run, "source_id": registered["id"],
                    "source_session_id": evicted.source_session_id, "next_sequence": 20})
                require(ack["has_gaps"] and not ack["complete"], "eviction was incorrectly acknowledged as durable")
            return {"sources": 9, "backlog_records": steps*8, "records_before_kill": first_count,
                    "verified": ["SIGKILL recovery", "same-session reconnect", "new-session restart", "explicit eviction gap"]}
    finally:
        lab.close()


def lifecycle_campaign(root, iterations, timeout):
    require(timeout > 0, "timeout must be positive")
    errors = []
    for iteration in range(iterations):
        run = tracker.Run(project="simulation", name=f"finish-{iteration}", watchdog_interval_ms=0)
        run.log({"value": iteration}, commit=False)
        barrier = threading.Barrier(8)

        def finish(_):
            barrier.wait()
            return run.finish()

        try:
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = [pool.submit(finish, i) for i in range(8)]
                for future in futures:
                    try:
                        future.result(timeout=timeout)
                    except Exception as error:
                        errors.append({"iteration": iteration, "error": repr(error)})
            require(run.info()["status"] == "finished", "concurrent finish did not finish")
            records = json.loads(run.history_bytes())["snapshots"]
            require(sum(row["state"]["tracker"]["kind"] == "event" for row in records) == 1,
                    "concurrent finish emitted duplicate lifecycle events")
        finally:
            run.close()
    require(not errors, f"concurrent finish errors: {errors[:10]} (total={len(errors)})")
    return {"iterations": iterations, "concurrent_finish_callers": 8, "errors": errors}


def registry_campaign(root):
    lab = Lab(root)
    try:
        invalid = [
            ("/api/experiments/experiments", {"project_id": "absent-project", "name": "orphan"}),
            ("/api/experiments/runs", {"experiment_id": "absent-experiment", "name": "orphan", "config": {}}),
            ("/api/experiments/sources", {"run_id": "absent-run", "attempt_id": "a", "role": "worker",
                                       "endpoint": "http://127.0.0.1:1"}),
        ]
        results = []
        for path, payload in invalid:
            try:
                results.append({"path": path, "accepted": lab.request(path, payload)})
            except RuntimeError as error:
                results.append({"path": path, "status": getattr(error.__cause__, "code", None), "error": str(error)})
        require(all(result.get("status") == 400 and "unknown" in result["error"].lower()
                    for result in results), f"invalid parent responses: {results}")
        stats = lab.request("/api/experiments/stats")
        require(all(stats[key] == 0 for key in ("projects", "experiments", "runs", "sources")),
                f"invalid inputs mutated registry: {stats}")
        return {"rejected_orphan_inputs": len(invalid), "stats": stats}
    finally:
        lab.close()


class StepModel:
    def __init__(self, policy, capacity=64):
        self.policy = policy
        self.capacity = capacity
        self.next_step = 0
        self.open_step = None
        self.open = {}
        self.last_step = None
        self.summary = {}
        self.history = OrderedDict()
        self.commits = 0

    @property
    def current_step(self):
        return self.next_step if self.open_step is None else self.open_step

    def flush(self):
        if self.open_step is None:
            return
        step = self.open_step
        self.summary.update(self.open)
        row = self.history.pop(step, {})
        row.update(self.open)
        self.history[step] = row
        while len(self.history) > self.capacity:
            self.history.popitem(last=False)
        self.next_step = max(self.next_step, step + 1)
        self.last_step = step
        self.open_step = None
        self.open = {}
        self.commits += 1

    def log(self, data, step, commit):
        target = self.current_step if step is None else step
        if self.policy == "monotonic" and (
            self.open_step is not None and target < self.open_step
            or self.open_step is None and target < self.next_step and target != self.last_step
        ):
            return False
        if self.open_step is not None and self.open_step != target:
            self.flush()
        self.open_step = target
        self.open.update(data)
        should_commit = step is None if commit is None else commit
        if should_commit:
            self.flush()
        return True


def model_campaign(root, iterations, seed):
    operations = 0
    rejected = 0
    for policy in ("monotonic", "allow"):
        for case in range(3):
            rng = random.Random(seed + case)
            reference = StepModel(policy)
            run = tracker.Run(project="simulation", name=f"model-{policy}-{case}",
                              step_policy=policy, capacity=128, history_steps=64, watchdog_interval_ms=0)
            try:
                with warnings.catch_warnings(record=True) as observed:
                    warnings.simplefilter("always", RuntimeWarning)
                    case_rejected = 0
                    for index in range(iterations):
                        step = rng.choice([None, reference.current_step, reference.current_step + rng.randrange(1, 4),
                                           max(0, reference.current_step - rng.randrange(1, 4))])
                        commit = rng.choice([None, True, False])
                        data = {rng.choice(["loss", "lr", "nullable", "a/b~c", "精确"]):
                                rng.choice([index, None, True, "value", 2**64 - 1])}
                        expected = reference.log(data, step, commit)
                        result = run.log(data, step=step, commit=commit, observed_at_ns=index * 1000)
                        require(result["accepted"] == expected,
                                f"admission mismatch seed={seed+case} op={index} policy={policy}")
                        require(run.step == reference.current_step,
                                f"run.step={run.step} next implicit log targets {reference.current_step}; "
                                f"seed={seed+case} op={index} explicit_step={step} commit={commit}")
                        if not expected:
                            case_rejected += 1
                        if index % 37 == 0:
                            require(run.summary == reference.summary, "summary diverged from reference model")
                            require(run.history(-1, include_meta=False, include_open=False) ==
                                    list(reference.history.values()), "retained history diverged from reference model")
                            require(run.info()["commits"] == reference.commits, "commit counter mismatch")
                        operations += 1
                    require(len(observed) == case_rejected, "rejected steps were not explicitly reported")
                    rejected += case_rejected
                run.flush()
                reference.flush()
                require(run.summary == reference.summary, "final model summary mismatch")
                require(run.history(-1, include_meta=False, include_open=False) ==
                        list(reference.history.values()), "final model history mismatch")
            finally:
                run.close()
    return {"operations": operations, "rejected_monotonic_steps": rejected,
            "policies": ["monotonic", "allow"], "seeds": list(range(seed, seed + 3))}


def collections_campaign(root, count, timeout):
    lab = Lab(root)
    try:
        run = lab.hierarchy(1)[0]["id"]
        with Source(project="simulation", experiment="training", run_id=run,
                    role="worker", capacity=count + 64) as source:
            source.serve()
            registration = lab.register(run, source.endpoint)
            items = [{"id": 2**63 + i, "label": f"row-{i}", "score": i} for i in range(count)]
            source.capture({"items": items, "metrics": {"loss": 0.25}})
            cutoff = count // 3
            expected = list(range(count - 1, cutoff, -1))
            wait_until(lambda: lab.request("/api/experiments/stats")["snapshots"] == 1,
                       time.monotonic() + timeout, "collection observation")
            actual = []
            offset = 0
            page_count = 0
            while True:
                result = lab.request("/api/tables/rows", {
                    "run_ids": [run], "source_ids": [registration["id"]], "path": "/items",
                    "columns": ["/id", "/score", "/label"], "offset": offset, "limit": 127,
                    "filters": [{"path": "/id", "op": "gt", "value": str(2**63 + cutoff)}],
                    "sort": {"path": "/id", "direction": "desc"},
                })
                page_count += 1
                require(result["total"] == len(expected), "exact-integer filter returned wrong total")
                for row in result["rows"]:
                    actual.append(int(row["cells"]["/id"]["text"]) - 2**63)
                if offset + len(result["rows"]) >= result["total"]:
                    break
                require(bool(result["rows"]), "table pagination stalled")
                offset += len(result["rows"])
            require(actual == expected, "table pagination lost order or integer precision")
            records = [{
                "record_version": 1, "action": "log", "name": "model", "type": "checkpoint",
                "digest": f"hash-{i}", "size": 2**64 - 1, "uri": f"sim://model/{i}",
                "aliases": ["best"] if i % 17 == 0 else [], "metadata": {"index": i},
            } for i in range(count)]
            for start in range(0, count, 64):
                source.capture({"tracker": {"record_version": 1, "kind": "event", "step": start,
                    "status": "running", "commit": start + 1}, "artifacts": records[start:start + 64]})
            target = source.stats().next_sequence
            ack_request = {"run_id": run, "source_id": registration["id"],
                           "source_session_id": source.source_session_id, "next_sequence": target}
            wait_until(lambda: lab.request("/api/snapshots/ack", ack_request)["complete"],
                       time.monotonic() + timeout, "artifact observations")
            cursor = None
            recovered = []
            artifact_pages = 0
            first_page = None
            while True:
                page = lab.request("/api/artifacts/lineage", {
                    "run_ids": [run], "source_ids": [registration["id"]], "limit": 137, "before": cursor,
                })
                artifact_pages += 1
                require(page["coverage"]["complete"], "valid lineage marked incomplete")
                if first_page is None:
                    first_page = page
                for item in page["artifacts"]:
                    require(item["size"] == 2**64 - 1, "artifact size lost unsigned precision")
                    recovered.append(item["metadata"]["index"])
                if page["next_before"] is None:
                    break
                require(page["next_before"] != cursor, "artifact cursor stalled")
                cursor = page["next_before"]
            require(recovered == list(range(count - 1, -1, -1)), "artifact composite paging mismatch")
            best = lab.request("/api/artifacts/resolve", {"run_ids": [run], "name": "model", "alias": "best"})
            require(best["artifact"]["metadata"]["index"] == ((count - 1) // 17) * 17,
                    "artifact alias did not select latest matching record")
            require(lab.request("/api/snapshots/latest", {"run_id": run})["snapshots"][0]["sequence"] == 0,
                    "artifact events replaced state head")
            source.capture({"tracker": {"record_version": 1, "kind": "event", "step": count,
                "status": "running", "commit": count+1}, "artifacts": [{"record_version": 99}]})
            ack_request["next_sequence"] = source.stats().next_sequence
            wait_until(lambda: lab.request("/api/snapshots/ack", ack_request)["complete"],
                       time.monotonic() + timeout, "invalid historical artifact evidence")
            incomplete = lab.request("/api/artifacts/lineage", {"run_ids": [run], "limit": 1})
            require(incomplete["coverage"] == {"complete": False, "excluded_records": 1}, "exclusion coverage mismatch")
            lab.stop()
            with sqlite3.connect(root / "data" / "snapshots.db") as database:
                database.execute("DROP TABLE artifact_aliases")
            lab.start()
            rebuilt = lab.request("/api/artifacts/lineage", {
                "run_ids": [run], "source_ids": [registration["id"]], "limit": 137,
            })
            require(rebuilt["artifacts"] == first_page["artifacts"], "rebuilding index changed evidence")
            require(rebuilt["coverage"] == incomplete["coverage"], "rebuilding index lost exclusion coverage")
            return {"collection_rows": count, "filtered_sorted_rows": len(expected), "table_pages": page_count,
                    "artifact_records": count, "artifact_pages": artifact_pages, "rebuild_preserved_ids": True,
                    "unsigned_64bit_values_preserved": True, "excluded_historical_records": 1}
    finally:
        lab.close()


def storage_campaign(root, iterations):
    require(iterations <= 1000, "storage probe is limited to 1000 iterations")
    result = {"scope": "isolated 4 KiB writes on the campaign filesystem; not RVX throughput",
              "io_pressure_before": Path("/proc/pressure/io").read_text()}
    payload = b"x" * 4096
    timings = []
    with (root / "fsync-probe").open("wb") as output:
        for _ in range(iterations):
            started = time.perf_counter()
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
            timings.append((time.perf_counter() - started) * 1000)
    result["file_write_fsync"] = percentiles(timings)
    for batch in (1, 64):
        timings = []
        with sqlite3.connect(root / f"wal-probe-{batch}.db") as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("CREATE TABLE samples (value BLOB)")
            started = time.perf_counter()
            for offset in range(0, iterations, batch):
                start = time.perf_counter()
                connection.executemany("INSERT INTO samples VALUES (?)",
                                       [(payload,)] * min(batch, iterations - offset))
                connection.commit()
                timings.append((time.perf_counter() - start) * 1000)
            elapsed = time.perf_counter() - started
            require(connection.execute("SELECT COUNT(*) FROM samples").fetchone()[0] == iterations,
                    "storage probe record mismatch")
        result[f"wal_full_batch_{batch}"] = {
            "rows": iterations, "rows_per_second": round(iterations / elapsed, 1),
            "commit_latency": percentiles(timings),
        }
    result["io_pressure_after"] = Path("/proc/pressure/io").read_text()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=("load", "recovery", "lifecycle", "registry", "model", "collections", "storage"), required=True)
    parser.add_argument("--sources", type=int, default=32)
    parser.add_argument("--steps", type=int, default=512)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--iterations", type=int, default=200)
    parser.add_argument("--seed", type=int, default=1729)
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--scrape-concurrency", type=int, default=32)
    parser.add_argument("--readers", type=int, default=2)
    parser.add_argument("--read-rps", type=float, default=0)
    parser.add_argument("--payload-kib", type=int, default=0)
    parser.add_argument("--numeric-fields", type=int, default=0)
    parser.add_argument("--read-phase-seconds", type=float, default=0)
    parser.add_argument("--keep-failed-data", action="store_true")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if not (1 <= args.sources <= 256 and 1 <= args.workers <= min(8, args.sources) and
            1 <= args.steps <= 4096 and 1 <= args.iterations <= 10000 and 1 <= args.timeout <= 1800
            and 1 <= args.scrape_concurrency <= 128 and 0 <= args.readers <= 8
            and 0 <= args.read_rps <= 64 and (args.readers > 0 or args.read_rps == 0)
            and 0 <= args.payload_kib <= 256 and 0 <= args.numeric_fields <= 1024
            and 0 <= args.read_phase_seconds <= 120
            and producer_buffer_limits(args.steps, args.payload_kib, args.numeric_fields)[1] <= 1024**3
            and args.sources * args.steps * (4096 + args.payload_kib * 2048 +
                                             args.numeric_fields * 64) <= 2 * 1024**3):
        parser.error("simulation resource limits exceeded")
    (ROOT / ".build").mkdir(exist_ok=True)
    started = time.monotonic()
    report = {
        "scenario": args.scenario, "parameters": vars(args) | {"report": str(args.report)},
        "binary": str(BINARY), "binary_sha256": hashlib.sha256(BINARY.read_bytes()).hexdigest(),
        "native_sdk_sha256": hashlib.sha256(Path(_native.__file__).read_bytes()).hexdigest(),
        "harness_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "performance_probes_sha256": hashlib.sha256((ROOT / "tests/performance.py").read_bytes()).hexdigest(),
        "sdk_run_sha256": hashlib.sha256((ROOT / "src/rvx/_tracker_run.py").read_bytes()).hexdigest(),
        "python": sys.version,
        "scope": "CPU-local synthetic data and loopback HTTP; no GPU or multi-machine claim",
    }
    with tempfile.TemporaryDirectory(prefix=f"rvx-sim-{args.scenario}-", dir=ROOT / ".build") as directory:
        root = Path(directory)
        try:
            if args.scenario == "load":
                report["measurements"] = {}
                report["measurements"] = load_campaign(root, args.sources, args.steps, args.workers,
                                                       args.timeout, args.scrape_concurrency,
                                                       args.readers, report["measurements"], args.read_rps,
                                                       args.payload_kib, args.numeric_fields,
                                                       args.read_phase_seconds)
            elif args.scenario == "recovery":
                report["measurements"] = recovery_campaign(root, args.steps, args.timeout)
            elif args.scenario == "lifecycle":
                report["measurements"] = lifecycle_campaign(root, args.iterations, args.timeout)
            elif args.scenario == "model":
                report["measurements"] = model_campaign(root, args.iterations, args.seed)
            elif args.scenario == "collections":
                report["measurements"] = collections_campaign(root, args.steps, args.timeout)
            elif args.scenario == "storage":
                report["measurements"] = storage_campaign(root, args.iterations)
            else:
                report["measurements"] = registry_campaign(root)
            report["status"] = "passed"
        except Exception:
            report["status"] = "failed"
            report["error"] = traceback.format_exc()
        finally:
            if (root / "daemon.log").exists():
                report["daemon_log_tail"] = (root / "daemon.log").read_text()[-8000:]
        if report["status"] == "failed" and args.keep_failed_data:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            destination = args.report.parent / root.name
            root.rename(destination)
            report["retained_data"] = str(destination)
    report["elapsed_seconds"] = round(time.monotonic() - started, 3)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
