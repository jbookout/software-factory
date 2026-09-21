import importlib.util
import io
import json
import pathlib
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


if __name__ == "__main__":
    unittest.main()
