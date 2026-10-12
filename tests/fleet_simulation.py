"""Opt-in single-daemon, per-card native Source simulations; no GPU is used."""
from __future__ import annotations

import argparse
from contextlib import ExitStack, closing
import hashlib
import heapq
import json
import math
import multiprocessing as mp
from pathlib import Path
import sqlite3
import tempfile
import time
import traceback

from rvx import Source, _native, tracker
from tests.performance import ProcessSampler, ReadLoad, percentiles
from tests.simulation import BINARY, ROOT, Lab, require


def card_role(index, scenario, trainers):
    return "trainer" if scenario == "trainer" or (scenario == "mixed" and index < trainers) else "rollout"


def card_metrics(index, step, role):
    shared = {
        "step": step, "policy_version": step // 4,
        "gpu_utilization": 70 + (index + step) % 30,
        "memory_gib": 32 + index % 16,
    }
    if role == "trainer":
        return shared | {
            "loss": (index + step + 1) / 1024, "lr": 0.0001,
            "grad_norm": step / 16, "tokens": (step + 1) * 8192,
            "step_ms": 750 + index % 100, "kl": step / 1024,
            "entropy": 2 + index / 1024, "reward": step / 64,
        }
    return shared | {
        "generated_tokens": (step + 1) * 4096, "tokens_per_second": 512 + index % 128,
        "completed_episodes": step * 8, "pending_requests": (index + step) % 32,
        "batch_size": 16, "generation_ms": 250 + step % 100,
        "reward_mean": step / 64, "queue_depth": (index + step) % 64,
    }


def rollout_state(index, step, rows):
    return {
        "metrics": card_metrics(index, step, "rollout"),
        "requests": [
            {"id": f"card-{index}-request-{row}", "status": "generating" if row % 2 else "queued",
             "tokens": step * 32 + row, "request_key": 2**64 - 1 - row}
            for row in range(rows)
        ],
    }


def observation_count(duration, rate):
    return math.floor(duration * rate + 1e-9)


def produce(connection, assignments, options, owners, sources):
    ready = []
    for index, role, run in assignments:
        rate = options[f"{role}_hz"]
        count = observation_count(options["duration"], rate)
        common = dict(project="simulation", experiment="training", run_id=run, role=role,
                      rank=index, node_id=f"synthetic-node-{index // 8}",
                      capacity=count + 2, max_buffer_bytes=32 * 1024 * 1024)
        if role == "trainer":
            source = tracker.Run(**common, name=f"trainer-{index}", history_steps=16,
                                 watchdog_interval_ms=0, config={"synthetic_gpu_rank": index})
        else:
            source = Source(**common)
        owners.callback(source.close)
        source.serve()
        sources[index] = source
        ready.append({"rank": index, "role": role, "session": source.source_session_id,
                      "endpoint": source.endpoint, "observations": count,
                      "records": count + (role == "trainer")})
    connection.send(("ready", ready))
    require(connection.poll(options["timeout"]), "fleet start command timed out")
    command, start = connection.recv()
    require(command == "start", "invalid fleet start command")
    pending = []
    for item in ready:
        period = 1 / options[f"{item['role']}_hz"]
        phase = item["rank"] / options["cards"] * period
        heapq.heappush(pending, (start + phase, item["rank"], 0, period, item))
    latencies = {"trainer": [], "rollout": []}
    lags = []
    generated = 0
    last_progress = time.monotonic()
    first_ns = None
    last_ns = None
    while pending:
        due, index, step, period, item = heapq.heappop(pending)
        delay = due - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        lags.append(max(0, time.monotonic() - due) * 1000)
        source = sources[index]
        observed = time.time_ns()
        first_ns = observed if first_ns is None else first_ns
        last_ns = observed
        began = time.perf_counter()
        if item["role"] == "trainer":
            metrics = card_metrics(index, step, "trainer")
            source.log({"loss": metrics.pop("loss"), "lr": metrics.pop("lr")}, step=step,
                       commit=False, observed_at_ns=observed)
            result = source.log(metrics, step=step, commit=True, observed_at_ns=observed)
            require(result["accepted"] and result["committed"] == 1, "trainer commit rejected")
        else:
            source.capture(rollout_state(index, step, options["rows"]),
                           axes={"step": step}, observed_at_ns=observed)
        latencies[item["role"]].append((time.perf_counter() - began) * 1000)
        generated += 1
        if step + 1 < item["observations"]:
            heapq.heappush(pending, (due + period, index, step + 1, period, item))
        if time.monotonic() - last_progress >= 1:
            connection.send(("progress", {"generated": generated}))
            last_progress = time.monotonic()
    for item in ready:
        source = sources[item["rank"]]
        if item["role"] == "trainer":
            source.finish()
        else:
            source.seal()
        page = json.loads(source.history_bytes(after=0, limit=1))
        require(page["oldest_sequence"] == 0, f"fleet fixture evicted card {item['rank']}")
    connection.send(("done", {
        "sources": ready, "generated": generated,
        "production_seconds": round(time.monotonic() - start, 3),
        "first_observed_at_ns": first_ns, "last_observed_at_ns": last_ns,
        "capture_latency": {role: percentiles(values) for role, values in latencies.items()},
        "schedule_lag": percentiles(lags),
    }))
    require(connection.poll(options["timeout"]), "fleet cleanup command timed out")
    require(connection.recv() == "close", "invalid fleet cleanup command")


def worker(connection, assignments, options):
    with ExitStack() as owners:
        owners.callback(connection.close)
        try:
            produce(connection, assignments, options, owners, {})
        except Exception:
            connection.send(("error", traceback.format_exc()))
            raise


def verify_store(root, identities, rows):
    lags = []
    seen = {source_id: 0 for source_id in identities}
    encoded_bytes = 0
    with closing(sqlite3.connect(f"file:{root / 'data/snapshots.db'}?mode=ro", uri=True)) as db:
        require(db.execute("PRAGMA quick_check").fetchone()[0] == "ok", "SQLite integrity check failed")
        for source_id, raw, ingested in db.execute(
            "SELECT source_id,snapshot_json,ingested_at_ns FROM snapshots ORDER BY id"
        ):
            snapshot = json.loads(raw)
            item = identities[source_id]
            step = seen[source_id]
            require(snapshot["sequence"] == step, "noncontiguous or duplicate Source sequence")
            require(snapshot["source_session_id"] == item["session"], "wrong Source session")
            state = snapshot["state"]
            if item["role"] == "trainer" and step == item["observations"]:
                require(state["tracker"]["kind"] == "event" and state["tracker"]["status"] == "finished",
                        "trainer did not finish with a distinct event")
            else:
                expected = card_metrics(item["rank"], step, item["role"])
                require(state["metrics"] == expected, f"card {item['rank']} step {step} metrics differ")
                require(snapshot["axes"] == {"step": step}, "wrong training/rollout axis")
                if item["role"] == "trainer":
                    require(state["tracker"]["kind"] == "observation", "event polluted observations")
                    require(state["summary"] == expected, "trainer summary differs")
                else:
                    require(state == rollout_state(item["rank"], step, rows), "rollout state differs")
                lag = (ingested - snapshot["observed_at_ns"]) / 1_000_000
                require(lag >= 0, "negative same-host observation lag")
                lags.append(lag)
            encoded_bytes += len(raw.encode())
            seen[source_id] += 1
        for source_id, item in identities.items():
            require(seen[source_id] == item["records"], f"missing records for {source_id}")
            cursor = db.execute(
                "SELECT next_sequence FROM snapshot_cursors WHERE source_id=? AND source_session_id=?",
                (source_id, item["session"])).fetchone()
            require(cursor == (item["records"],), f"wrong persisted cursor for {source_id}")
            head = db.execute(
                "SELECT s.sequence FROM snapshot_heads h JOIN snapshots s ON s.id=h.snapshot_id "
                "WHERE h.source_id=?", (source_id,)).fetchone()
            require(head == (item["observations"] - 1,), "latest head is not the final observation")
        require(db.execute("SELECT COUNT(*) FROM snapshot_gaps").fetchone()[0] == 0, "retention gaps")
        page_size = db.execute("PRAGMA page_size").fetchone()[0]
        page_count = db.execute("PRAGMA page_count").fetchone()[0]
        return {
            "verified_sources": len(seen), "verified_records": sum(seen.values()),
            "snapshot_json_bytes": encoded_bytes, "observation_ingest_lag": percentiles(lags),
            "indexed_values": db.execute("SELECT COUNT(*) FROM chart_values").fetchone()[0],
            "source_field_pairs": db.execute("SELECT COUNT(*) FROM chart_fields").fetchone()[0],
            "database_integrity": "ok",
            "snapshot_database_bytes": (root / "data/snapshots.db").stat().st_size,
            "sqlite_page_size": page_size,
            "sqlite_page_count": page_count,
            "sqlite_free_pages": db.execute("PRAGMA freelist_count").fetchone()[0],
            "logical_database_bytes": page_count * page_size,
        }


def api_probe(lab, path, payload):
    started = time.perf_counter()
    try:
        value = lab.request(path, payload)
    except (RuntimeError, TimeoutError) as error:
        return {"status": "error", "http_status": getattr(error.__cause__, "code", None),
                "error": str(error), "latency_ms": round((time.perf_counter() - started) * 1000, 3)}
    result = {"status": "ok", "latency_ms": round((time.perf_counter() - started) * 1000, 3)}
    if path.endswith("catalog"):
        result.update(metrics=len(value["metrics"]), truncated=value["truncated"],
                      metric_source_pairs=sum(len(metric["sources"]) for metric in value["metrics"]))
    elif path.endswith("query"):
        result.update(series=len(value["series"]), points=sum(len(s["values"]) for s in value["series"]))
    else:
        result["rows"] = len(value["rows"])
    return result


def campaign(root, args, measurements):
    lab = Lab(root, concurrency=args.scrape_concurrency)
    children, pipes, samplers = [], [], []
    read_load = None
    try:
        run = lab.hierarchy(1)[0]["id"]
        assignments = [(i, card_role(i, args.scenario, args.trainers), run) for i in range(args.cards)]
        measurements["roles"] = {role: sum(a[1] == role for a in assignments)
                                 for role in ("trainer", "rollout")}
        observations = sum(observation_count(args.duration, getattr(args, f"{role}_hz"))
                           for _, role, _ in assignments)
        total = observations + measurements["roles"]["trainer"]
        measurements.update(
            expected_observations=observations, expected_records=total,
            offered_observations_per_second=sum(
                measurements["roles"][role] * getattr(args, f"{role}_hz")
                for role in ("trainer", "rollout")),
        )
        context = mp.get_context("spawn")
        for number in range(args.workers):
            parent, child = context.Pipe()
            process = context.Process(target=worker, args=(
                child, assignments[number::args.workers], vars(args)), daemon=True)
            process.start()
            child.close()
            children.append(process)
            pipes.append(parent)
        ready = []
        deadline = time.monotonic() + 120
        for pipe in pipes:
            require(pipe.poll(max(0, deadline - time.monotonic())), "fleet startup timed out")
            kind, result = pipe.recv()
            require(kind == "ready", f"fleet startup failed: {result}")
            ready.extend(result)
        require(len({item["endpoint"] for item in ready}) == args.cards, "Sources must have distinct ports")
        measurements["native_http_listeners"] = len(ready)
        start_register = time.monotonic()
        identities = {}
        for item in ready:
            source = lab.register(run, item["endpoint"], role=item["role"],
                                  interval=args.scrape_interval_ms, timeout=5000)
            identities[source["id"]] = item
        measurements["registration_seconds"] = round(time.monotonic() - start_register, 3)
        if args.profile_ingestion:
            measurements["ingestion_before"] = lab.request("/api/experiments/ingestion")
        samplers = [ProcessSampler(lab.process.pid, files={
            "snapshot_wal": root / "data/snapshots.db-wal",
            "metadata_wal": root / "data/metadata.db-wal",
        }), *[ProcessSampler(p.pid) for p in children]]
        start = time.monotonic() + 1
        for pipe in pipes:
            pipe.send(("start", start))
        ordered = sorted(identities, key=lambda source: identities[source]["rank"])
        selected = ordered[::max(1, args.cards // 16)][:16]
        read_load = ReadLoad(lab, [run], 2, args.read_rps,
                             source_ids=selected, metric_path="/metrics/step")
        finished = set()
        generated = {i: 0 for i in range(len(pipes))}
        measurements["workers"] = []
        measurements["progress"] = []
        deadline = start + args.timeout
        producer_done_at = None
        while time.monotonic() < deadline:
            for number, pipe in enumerate(pipes):
                while number not in finished and pipe.poll():
                    kind, result = pipe.recv()
                    require(kind in ("progress", "done"), f"fleet worker failed: {result}")
                    generated[number] = result["generated"]
                    if kind == "done":
                        finished.add(number)
                        measurements["workers"].append({key: value for key, value in result.items()
                                                         if key != "sources"})
            stats = lab.request("/api/experiments/stats")
            elapsed = max(0, time.monotonic() - start)
            measurements["last_stats"] = stats
            measurements["progress"].append({
                "seconds": round(elapsed, 3), "persisted": stats["snapshots"],
                "reported_generated_observations": sum(generated.values()),
                "finished_workers": len(finished), "active_sources": stats["active_sources"],
                "scrape_failures": stats["scrape_failures"],
            })
            require(stats["cursor_gaps"] == 0, "fleet producer retention gap")
            if len(finished) == len(pipes) and producer_done_at is None:
                producer_done_at = max(worker["production_seconds"] for worker in measurements["workers"])
                measurements["records_at_done_detection"] = stats["snapshots"]
            if len(finished) == len(pipes) and stats["snapshots"] == total:
                measurements.update(
                    elapsed_ingest_seconds=round(elapsed, 3),
                    persisted_records_per_second=round(total / elapsed, 3),
                    producer_seconds=producer_done_at,
                    catchup_seconds=round(max(0, elapsed - producer_done_at), 3),
                )
                break
            time.sleep(2)
        else:
            raise AssertionError(f"fleet did not drain {total} records within {args.timeout}s")
        measurements["reads"] = read_load.stop()
        measurements["daemon_resources"] = samplers[0].stop()
        measurements["producer_resources"] = [sampler.stop() for sampler in samplers[1:]]
        if args.profile_ingestion:
            measurements["ingestion_after"] = lab.request("/api/experiments/ingestion")
        lab.stop()
        measurements["verification"] = verify_store(root, identities, args.rows)
        # Queries on a stopped-writer dataset: disable registrations only while the daemon is stopped.
        with closing(sqlite3.connect(root / "data/metadata.db")) as db:
            db.execute("UPDATE sources SET state='ended'")
            db.commit()
        lab.start()
        require(lab.request("/api/experiments/stats")["snapshots"] == total, "restart changed record count")
        measurements["query_probes"] = {
            "full_run_catalog": api_probe(lab, "/api/charts/catalog", {"run_ids": [run]}),
            "full_run_step": api_probe(lab, "/api/snapshots/query", {
                "run_ids": [run], "paths": ["/metrics/step"], "axis": "step", "max_points": 32}),
            "full_run_table_summary": api_probe(lab, "/api/tables/summary", {
                "run_ids": [run], "paths": ["/metrics/step"], "axis": "step"}),
            "selected_16_step": api_probe(lab, "/api/snapshots/query", {
                "run_ids": [run], "source_ids": selected, "paths": ["/metrics/step"],
                "axis": "step", "max_points": 32}),
        }
        require(not measurements["reads"]["errors"], str(measurements["reads"]["errors"]))
        require(all(not sampler.stop()["errors"] for sampler in samplers), "resource sampling failed")
    finally:
        if read_load:
            measurements["reads"] = read_load.stop()
        if samplers:
            measurements["daemon_resources"] = samplers[0].stop()
            measurements["producer_resources"] = [sampler.stop() for sampler in samplers[1:]]
        measurements["request_failures"] = lab.request_failures
        for pipe in pipes:
            try:
                pipe.send("close")
            except (BrokenPipeError, EOFError):
                pass
        for process in children:
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=("trainer", "rollout", "mixed"), required=True)
    parser.add_argument("--cards", type=int, default=1024)
    parser.add_argument("--trainers", type=int, default=128)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--duration", type=int, default=60)
    parser.add_argument("--trainer-hz", type=float, default=1)
    parser.add_argument("--rollout-hz", type=float, default=1)
    parser.add_argument("--rows", type=int, default=16)
    parser.add_argument("--scrape-concurrency", type=int, default=16)
    parser.add_argument("--scrape-interval-ms", type=int, default=1000)
    parser.add_argument("--read-rps", type=float, default=2)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--keep-failed-data", action="store_true")
    parser.add_argument("--profile-ingestion", action="store_true",
                        help="Collect writer phase diagnostics; requires the ingestion diagnostics API")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if not (1 <= args.cards <= 1024 and 1 <= args.workers <= min(8, args.cards)
            and 0 <= args.trainers <= args.cards and 2 <= args.duration <= 180
            and 1 <= args.scrape_concurrency <= 64 and 1000 <= args.scrape_interval_ms <= 10000
            and 0 < args.read_rps <= 4 and 0 <= args.rows <= 32 and 30 <= args.timeout <= 1200
            and args.timeout > args.duration
            and all(0.1 <= hz <= 10 and 2 <= observation_count(args.duration, hz) <= 256
                    for hz in (args.trainer_hz, args.rollout_hz))):
        parser.error("fleet resource or pacing limits exceeded")
    (ROOT / ".build").mkdir(exist_ok=True)
    report = {
        "parameters": vars(args) | {"report": str(args.report)},
        "scope": "One host, one Run, one daemon, one native HTTP Source per logical card; no actual GPU or distributed network.",
        "binary_sha256": hashlib.sha256(BINARY.read_bytes()).hexdigest(),
        "native_sdk_sha256": hashlib.sha256(Path(_native.__file__).read_bytes()).hexdigest(),
        "harness_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "shared_lab_sha256": hashlib.sha256((ROOT / "tests/simulation.py").read_bytes()).hexdigest(),
        "performance_probes_sha256": hashlib.sha256((ROOT / "tests/performance.py").read_bytes()).hexdigest(),
        "status_meaning": "Passed means complete data verification and no unexpected reader errors, not a throughput or freshness SLA. Query limit probes may report explicit errors.",
        "lag_meaning": "Same-host observed_at_ns to ingested_at_ns recorded before transaction commit; not a per-record fsync acknowledgment.",
        "measurements": {},
    }
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="rvx-fleet-", dir=ROOT / ".build") as directory:
        root = Path(directory)
        try:
            campaign(root, args, report["measurements"])
            report["status"] = "passed"
        except Exception:
            report["status"] = "failed"
            report["error"] = traceback.format_exc()
        if (root / "daemon.log").exists():
            report["daemon_log_tail"] = (root / "daemon.log").read_text()[-8000:]
        if report["status"] == "failed" and args.keep_failed_data:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            destination = args.report.parent / root.name
            root.rename(destination)
            report["retained_data"] = str(destination)
    report["elapsed_seconds"] = round(time.monotonic() - started, 3)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    compact = {"status": report["status"], "elapsed_seconds": report["elapsed_seconds"]}
    compact.update({key: value for key, value in report["measurements"].items()
                    if key not in ("progress", "producer_resources", "daemon_resources", "workers",
                                   "ingestion_before", "ingestion_after")})
    if "error" in report:
        compact["error"] = report["error"]
    print(json.dumps(compact, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
