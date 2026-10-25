import importlib.util
import json
import socket
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock, patch

SCRIPT_PATH = (
    Path(__file__).resolve().parents[2]
    / "public"
    / "reference"
    / "WebsiteStreamStart.py"
)
SPEC = importlib.util.spec_from_file_location("website_stream_start", SCRIPT_PATH)
website_stream_start = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = website_stream_start
SPEC.loader.exec_module(website_stream_start)


class TriggerResponse:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


class WebsiteStreamStartTests(unittest.TestCase):
    def run_trigger(self, opener):
        with (
            patch.object(website_stream_start, "CONTROL_URL", "http://127.0.0.1:420/stream-control"),
            patch.object(website_stream_start, "stream_control_token", return_value="t" * 40),
            patch.object(website_stream_start.urllib.request, "build_opener", return_value=opener),
            patch.object(website_stream_start, "acquire_toggle_mutex", return_value=object()),
            patch.object(website_stream_start, "release_toggle_mutex"),
            patch.object(website_stream_start, "show_error") as show_error,
        ):
            result = website_stream_start.main()
        return result, show_error

    def test_posts_one_authenticated_toggle_with_unique_request_id(self):
        opener = Mock()
        opener.open.return_value = TriggerResponse(b'{"streaming":true}')

        result, show_error = self.run_trigger(opener)

        self.assertEqual(result, 0)
        show_error.assert_not_called()
        opener.open.assert_called_once()
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), f"Bearer {'t' * 40}")
        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(body["action"], "toggle")
        self.assertRegex(
            body["request_id"],
            r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        )

    def test_authentication_failure_is_reported_without_retry(self):
        opener = Mock()
        opener.open.side_effect = urllib.error.HTTPError(
            "http://127.0.0.1:420/stream-control",
            401,
            "Unauthorized",
            {},
            None,
        )

        result, show_error = self.run_trigger(opener)

        self.assertEqual(result, 1)
        self.assertIn("authentication failed", show_error.call_args.args[0])
        opener.open.assert_called_once()

    def test_timeout_is_reported_without_retry(self):
        opener = Mock()
        opener.open.side_effect = urllib.error.URLError(socket.timeout())

        result, show_error = self.run_trigger(opener)

        self.assertEqual(result, 1)
        self.assertIn("timed out", show_error.call_args.args[0])
        opener.open.assert_called_once()

    def test_unavailable_server_is_reported_without_retry(self):
        opener = Mock()
        opener.open.side_effect = urllib.error.URLError(ConnectionRefusedError())

        result, show_error = self.run_trigger(opener)

        self.assertEqual(result, 1)
        self.assertIn("Could not reach", show_error.call_args.args[0])
        opener.open.assert_called_once()

    def test_invalid_backend_response_is_not_reported_as_success(self):
        opener = Mock()
        opener.open.return_value = TriggerResponse(b'{"streaming":"true"}')

        result, show_error = self.run_trigger(opener)

        self.assertEqual(result, 1)
        self.assertIn("invalid state", show_error.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
