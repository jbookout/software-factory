import importlib.util
import io
import json
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("jev_browser_select", HERE / "select.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class BrowserSelectTest(unittest.TestCase):
    def setUp(self):
        self.snapshot = {
            "goal": "Open the article about otters", "url": "https://example.org/search?q=private#fragment",
            "site_clearance": "public",
            "controls": [{"index": 7, "role": "link", "name": "Otters"}],
        }

    def test_one_request_excludes_query_and_form_values(self):
        seen = []

        def send(request, timeout):
            seen.append(json.loads(request.data))
            return Response(json.dumps({"answers": {
                "operation": {"choice": "click", "confidence": 0.9}, "target": {"choice": "control_7", "confidence": 0.95},
            }}).encode())

        chosen = MODULE.select(self.snapshot, api_key="synthetic", opener=send)
        self.assertEqual(chosen["target_index"], 7)
        self.assertEqual(chosen["operation"], "click")
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["state"]["page"], {"origin": "https://example.org", "path": "/search"})
        self.assertNotIn("private", json.dumps(seen))

    def test_extra_control_fields_refuse_before_egress(self):
        self.snapshot["controls"][0]["value"] = "secret"
        with self.assertRaisesRegex(ValueError, "only index, role, name"):
            MODULE.select(self.snapshot, api_key="synthetic", opener=lambda *_: self.fail("egress"))

    def test_incompatible_answers_abstain(self):
        def send(_request, timeout):
            return Response(json.dumps({"answers": {
                "operation": {"choice": "finish", "confidence": 0.9}, "target": {"choice": "control_7", "confidence": 0.9},
            }}).encode())
        answer = MODULE.select(self.snapshot, api_key="synthetic", opener=send)
        self.assertFalse(answer["selected"])
        self.assertEqual(answer["reason"], "incompatible_answer")

    def test_missing_key_abstains(self):
        answer = MODULE.select(self.snapshot, api_key="", opener=lambda *_: self.fail("egress"))
        self.assertFalse(answer["selected"])

    def test_billable_browser_selection_has_one_usage_receipt_and_cached_repeat(self):
        calls = []
        with tempfile.TemporaryDirectory() as root:
            log = pathlib.Path(root) / "jev-calls.jsonl"
            cache = pathlib.Path(root) / "cache.sqlite3"

            def send(_request, timeout):
                calls.append(timeout)
                return Response(json.dumps({"model": "jev-1.13.0", "usage": {
                    "input_tokens": 90, "output_tokens": 2}, "answers": {
                    "operation": {"choice": "click", "confidence": 0.9},
                    "target": {"choice": "control_7", "confidence": 0.95},
                }}).encode())

            first = MODULE.select(self.snapshot, api_key="synthetic", opener=send,
                                  usage_log=log, cache_path=cache)
            second = MODULE.select(self.snapshot, api_key="synthetic", opener=send,
                                   usage_log=log, cache_path=cache)
            self.assertTrue(first["selected"])
            self.assertTrue(second["selected"])
            self.assertEqual(len(calls), 1)
            rows = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["usage"]["input_tokens"], 90)
            self.assertTrue(rows[1]["cache_hit"])
            self.assertFalse(rows[1]["ok"])
            self.assertNotIn("synthetic", log.read_text())

    def test_missing_usage_is_logged_unknown_and_still_cached(self):
        calls = []
        with tempfile.TemporaryDirectory() as root:
            log = pathlib.Path(root) / "jev-calls.jsonl"
            cache = pathlib.Path(root) / "cache.sqlite3"
            def send(_request, timeout):
                calls.append(timeout)
                return Response(json.dumps({"model": "jev-1.13.0", "answers": {
                    "operation": {"choice": "click", "confidence": 0.9},
                    "target": {"choice": "control_7", "confidence": 0.95},
                }}).encode())
            MODULE.select(self.snapshot, api_key="synthetic", opener=send,
                          usage_log=log, cache_path=cache)
            MODULE.select(self.snapshot, api_key="synthetic", opener=send,
                          usage_log=log, cache_path=cache)
            self.assertEqual(len(calls), 1)
            rows = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertTrue(rows[0]["ok"])
            self.assertIsNone(rows[0]["usage"])
            self.assertTrue(rows[1]["cache_hit"])


if __name__ == "__main__":
    unittest.main()
