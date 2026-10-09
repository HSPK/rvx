from __future__ import annotations

import json
import unittest
from unittest.mock import Mock, patch

from rvx import RvxClient


def _response(payload):
    response = Mock()
    response.read.return_value = json.dumps(payload).encode()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=None)
    return response


class RvxClientTests(unittest.TestCase):
    def test_ensure_hierarchy_and_register_source(self):
        responses = [
            _response({"projects": []}),
            _response({"id": "project-1", "name": "demo"}),
            _response({"experiments": []}),
            _response(
                {"id": "experiment-1", "project_id": "project-1", "name": "async"}
            ),
            _response({"runs": []}),
            _response(
                {"id": "run-1", "experiment_id": "experiment-1", "name": "trial"}
            ),
            _response({"id": "source-1", "run_id": "run-1"}),
        ]
        client = RvxClient(
            "http://127.0.0.1:9110",
            token="secret",
        )

        with patch("rvx.client.urlopen", side_effect=responses) as request:
            hierarchy = client.ensure_hierarchy(
                "demo",
                "async",
                "trial",
                config={"seed": 1},
            )
            source = client.register_source(
                run_id=hierarchy["run"]["id"],
                role="trainer",
                endpoint="http://127.0.0.1:9200",
                rank=0,
            )

        self.assertEqual(hierarchy["run"]["id"], "run-1")
        self.assertEqual(source["id"], "source-1")
        registered = request.call_args_list[-1].args[0]
        self.assertEqual(registered.get_header("Authorization"), "Bearer secret")
        self.assertEqual(
            json.loads(registered.data),
            {
                "run_id": "run-1",
                "attempt_id": "attempt-1",
                "role": "trainer",
                "endpoint": "http://127.0.0.1:9200",
                "node_id": None,
                "rank": 0,
                "scrape_interval_ms": 1000,
                "timeout_ms": 5000,
            },
        )

    def test_client_rejects_credentialed_or_non_http_urls(self):
        for value in ("file:///tmp/rvx", "http://user@example.com"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                RvxClient(value)


if __name__ == "__main__":
    unittest.main()
