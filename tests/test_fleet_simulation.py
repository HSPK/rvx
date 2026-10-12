from contextlib import ExitStack
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock

from tests.fleet_simulation import card_metrics, card_role, observation_count, produce, rollout_state
from tests.performance import ProcessSampler, ReadLoad
from tests.simulation import BINARY, ROOT, Lab, wait_until
from rvx import Source


class FleetSimulationTests(unittest.TestCase):
    @unittest.skipUnless(BINARY.is_file(), "requires native daemon")
    def test_committed_large_wal_survives_sigkill_before_checkpoint(self):
        (ROOT / ".build").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / ".build") as directory:
            lab = Lab(Path(directory), concurrency=2)
            try:
                run = lab.hierarchy(1)[0]["id"]
                with Source(project="simulation", experiment="training", run_id=run,
                            role="worker", capacity=128, max_buffer_bytes=64 * 1024**2) as source:
                    source.serve()
                    registration = lab.register(run, source.endpoint)
                    payload = "x" * (128 * 1024)
                    for step in range(128):
                        source.capture({"step": step, "payload": payload}, axes={"step": step})
                    acknowledgment = {
                        "run_id": run, "source_id": registration["id"],
                        "source_session_id": source.source_session_id, "next_sequence": 128,
                    }
                    wait_until(lambda: lab.request("/api/snapshots/ack", acknowledgment)["complete"],
                               time.monotonic() + 30, "durable large-WAL prefix")
                    wal = Path(directory) / "data/snapshots.db-wal"
                    self.assertGreater(wal.stat().st_size, 16 * 1024**2)
                    lab.stop(crash=True)
                    lab.start()
                    self.assertEqual(lab.request("/api/experiments/stats")["snapshots"], 128)
                    self.assertTrue(lab.request("/api/snapshots/ack", acknowledgment)["complete"])
                    latest = lab.request("/api/snapshots/latest", {"run_id": run})["snapshots"][0]
                    self.assertEqual(latest["state"], {"step": 127, "payload": payload})
            finally:
                lab.close()

    @unittest.skipUnless(Path("/proc/self/stat").exists(), "requires Linux procfs")
    def test_wal_size_sampling_handles_a_not_yet_created_wal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture-wal"
            sampler = ProcessSampler(os.getpid(), files={"wal": path})
            try:
                self.assertEqual(sampler.samples[0]["file_bytes"]["wal"], 0)
                path.write_bytes(b"x" * 8192)
            finally:
                result = sampler.stop()
            self.assertEqual(result["file_sampled_peak_bytes"]["wal"], 8192)
            self.assertEqual(result["errors"], [])

    def test_scoped_reader_waits_for_a_selected_publisher(self):
        readers = ReadLoad(Mock(), ["run"], 0, source_ids=["selected"], metric_path="/metrics/step")
        metric = {"path": "/metrics/step", "sources": [{"run_id": "run", "source_id": "other"}]}
        self.assertFalse(readers._metric_available({"metrics": [metric]}, "run"))
        metric["sources"][0]["source_id"] = "selected"
        self.assertTrue(readers._metric_available({"metrics": [metric]}, "run"))
        self.assertFalse(readers._metric_available({"metrics": [metric]}, "another-run"))
        self.assertFalse(readers._metric_available({"metrics": []}, "run"))
        readers.stop()

    def test_role_counts_and_rate_counts(self):
        roles = [card_role(i, "mixed", 128) for i in range(1024)]
        self.assertEqual(roles.count("trainer"), 128)
        self.assertEqual(roles.count("rollout"), 896)
        self.assertTrue(all(card_role(i, "trainer", 128) == "trainer" for i in range(1024)))
        self.assertTrue(all(card_role(i, "rollout", 128) == "rollout" for i in range(1024)))
        self.assertEqual(observation_count(60, .1), 6)

    def test_native_fleet_preserves_roles_steps_events_and_history(self):
        pipe = Mock()
        pipe.poll.return_value = True
        pipe.recv.side_effect = [("start", time.monotonic() - 10), "close"]
        options = dict(duration=2, trainer_hz=1, rollout_hz=1, timeout=10, cards=2, rows=16)
        with ExitStack() as owners:
            sources = {}
            produce(pipe, [(0, "trainer", "run"), (1, "rollout", "run")], options, owners, sources)
            done = pipe.send.call_args_list[-1].args[0][1]
            self.assertEqual(done["generated"], 4)
            self.assertEqual([item["records"] for item in done["sources"]], [3, 2])
            for index, role in ((0, "trainer"), (1, "rollout")):
                page = json.loads(sources[index].history_bytes(after=0, limit=8))
                self.assertEqual(page["oldest_sequence"], 0)
                self.assertEqual(page["snapshots"][1]["state"]["metrics"], card_metrics(index, 1, role))
            trainer = json.loads(sources[0].latest_bytes())
            self.assertEqual(trainer["state"]["tracker"]["kind"], "observation")
            self.assertEqual(json.loads(sources[1].latest_bytes())["state"], rollout_state(1, 1, 16))
