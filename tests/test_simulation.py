import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from tests.simulation import Lab, _produce, producer_buffer_limits
from tests.performance import ProcessSampler, RateSchedule, ReadLoad


class SimulationOwnershipTests(unittest.TestCase):
    def test_failed_readiness_kills_and_reaps_only_the_owned_child(self):
        process = Mock()
        process.poll.return_value = None
        with tempfile.TemporaryDirectory() as directory:
            lab = Lab.__new__(Lab)
            lab.root = Path(directory)
            lab.concurrency = 1
            lab.process = None
            with patch("tests.simulation.subprocess.Popen", return_value=process), \
                 patch("tests.simulation.select.select", return_value=([], [], [])):
                with self.assertRaisesRegex(AssertionError, "readiness timeout"):
                    lab.start()
            process.kill.assert_called_once_with()
            process.communicate.assert_called_once_with(timeout=5)
            self.assertIsNone(lab.process)
            self.assertIsNone(lab.log)

    def test_failed_launch_closes_log_without_a_child_to_kill(self):
        with tempfile.TemporaryDirectory() as directory:
            lab = Lab.__new__(Lab)
            lab.root = Path(directory)
            lab.concurrency = 1
            lab.process = None
            with patch("tests.simulation.subprocess.Popen", side_effect=FileNotFoundError("fixture")):
                with self.assertRaisesRegex(FileNotFoundError, "fixture"):
                    lab.start()
            self.assertIsNone(lab.process)
            self.assertIsNone(lab.log)


class PerformanceProbeTests(unittest.TestCase):
    def test_large_payload_budget_preserves_full_producer_history(self):
        for payload_kib, fields in ((64, 0), (0, 512)):
            with self.subTest(payload_kib=payload_kib, fields=fields):
                connection = Mock()
                connection.poll.return_value = True
                connection.recv.side_effect = ["start", "close"]
                with ExitStack() as cleanup:
                    _produce(connection, [(1, "fixture")], 512, 10, [], cleanup, payload_kib, fields)
                self.assertEqual(connection.send.call_args_list[-1].args[0][0], "done")
                self.assertEqual(connection.send.call_args_list[-1].args[0][1]["sources"][0]["count"], 525)

    def test_long_load_retains_observations_and_all_tracker_events(self):
        for steps in (1, 32, 128, 512, 4096):
            events = len(range(0, steps, 64)) + len(range(0, steps, 128)) + 1
            capacity, byte_limit = producer_buffer_limits(steps)
            self.assertEqual(capacity, steps + events)
            self.assertLessEqual(byte_limit, 1024**3)

    def test_rate_schedule_reports_skips_instead_of_bursting_late_requests(self):
        schedule = RateSchedule(10, .25)
        self.assertEqual(schedule.next(9), (10, 0))
        self.assertEqual(schedule.next(11.1), (11, 3))
        self.assertEqual(schedule.next(11.1), (11.25, 0))

    def test_read_load_preserves_request_failures_and_stops(self):
        lab = Mock()
        lab.request.side_effect = TimeoutError("fixture timeout")
        readers = ReadLoad(lab, ["run"], 2)
        for thread in readers.threads:
            thread.join(2)
        report = readers.stop()
        self.assertEqual(report["attempted"], 2)
        self.assertEqual(len(report["errors"]), 2)
        self.assertEqual(report["completed"], 0)
        self.assertIs(readers.stop(), report)

    @unittest.skipUnless(Path("/proc/self/stat").exists(), "requires Linux procfs")
    def test_sampler_reports_owned_process_and_stops(self):
        sampler = ProcessSampler(os.getpid())
        report = sampler.stop()
        self.assertEqual(report["errors"], [])
        self.assertGreater(report["sampled_peak_rss_mib"], 0)
        self.assertGreaterEqual(report["process_lifetime_hwm_mib"], report["sampled_peak_rss_mib"])
        self.assertGreaterEqual(report["cpu_seconds"], 0)
        self.assertEqual(sampler.stop(), report)
from contextlib import ExitStack
