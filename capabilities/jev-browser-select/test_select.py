import importlib.util
import json
import pathlib
import unittest
import os
import urllib.request
from unittest.mock import patch

HERE = pathlib.Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("jev_browser_select", HERE / "select.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BrowserSelectTest(unittest.TestCase):
    def test_installed_helper_cannot_spend_during_offline_refusal(self):
        calls = []
        def send(request, timeout):
            calls.append(request)
            return {"answers": {
                "operation": {"choice": "click", "confidence": 0.9},
                "target": {"choice": "control_7", "confidence": 0.9}}}
        with patch.dict(os.environ, CARR_JEV_OFFLINE="1"), \
                patch.object(urllib.request, "urlopen", send):
            answer = MODULE.select(self.snapshot, api_key="synthetic")
        self.assertFalse(answer["selected"])
        self.assertEqual(calls, [])

    def setUp(self):
        self.snapshot = {
            "goal": "Open the article about otters", "url": "https://example.org/search?q=private#fragment",
            "site_clearance": "public",
            "controls": [{"index": 7, "role": "link", "name": "Otters"}],
        }

    def test_one_request_excludes_query_and_form_values(self):
        seen = []

        def send(payload, key):
            seen.append(payload)
            return {"answers": {
                "operation": {"choice": "click", "confidence": 0.9}, "target": {"choice": "control_7", "confidence": 0.95},
            }}

        chosen = MODULE.select(self.snapshot, api_key="synthetic", shared_ask=send)
        self.assertEqual(chosen["target_index"], 7)
        self.assertEqual(chosen["operation"], "click")
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["state"]["page"], {"origin": "https://example.org", "path": "/search"})
        self.assertNotIn("private", json.dumps(seen))

    def test_extra_control_fields_refuse_before_egress(self):
        self.snapshot["controls"][0]["value"] = "secret"
        with self.assertRaisesRegex(ValueError, "only index, role, name"):
            MODULE.select(self.snapshot, api_key="synthetic", shared_ask=lambda *_: self.fail("egress"))

    def test_incompatible_answers_abstain(self):
        def send(_payload, key):
            return {"answers": {
                "operation": {"choice": "finish", "confidence": 0.9}, "target": {"choice": "control_7", "confidence": 0.9},
            }}
        answer = MODULE.select(self.snapshot, api_key="synthetic", shared_ask=send)
        self.assertFalse(answer["selected"])
        self.assertEqual(answer["reason"], "incompatible_answer")

    def test_missing_key_abstains(self):
        answer = MODULE.select(self.snapshot, api_key="", shared_ask=lambda *_: self.fail("egress"))
        self.assertFalse(answer["selected"])

    def test_shared_admission_refusal_abstains(self):
        calls = []
        def refuse(payload, key):
            calls.append(payload)
            raise RuntimeError("credit_hold")
        chosen = MODULE.select(self.snapshot, api_key="synthetic", shared_ask=refuse)
        self.assertFalse(chosen["selected"])
        self.assertEqual(chosen["reason"], "jev_unavailable")
        self.assertEqual(len(calls), 1)

    def test_shared_results_do_not_create_a_private_cache(self):
        calls = []
        def send(payload, key):
            calls.append(payload)
            return {"answers": {"operation": {"choice":"click", "confidence":0.9},
                                "target": {"choice":"control_7", "confidence":0.9}}}
        MODULE.select(self.snapshot, api_key="synthetic", shared_ask=send)
        MODULE.select(self.snapshot, api_key="synthetic", shared_ask=send)
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
