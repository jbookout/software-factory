import importlib.util
from pathlib import Path
import unittest


MODULE = Path(__file__).resolve().parents[2] / "scripts/doc-drift/loops.py"


class Forge:
    def __init__(self):
        self.issues = []
        self.writes = []

    def list(self):
        return self.issues

    def create(self, title, body):
        self.issues.append(dict(number=len(self.issues) + 1, title=title, body=body, state="open"))
        self.writes.append("create")

    def update(self, number, body, state):
        self.issues[number - 1].update(body=body, state=state)
        self.writes.append("update")


class LoopTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("loops", MODULE)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.forge = Forge()
        self.report = dict(schema="doc-drift/v1", owner="orchestrator", source_sha="a" * 40,
                           scope="full", files_checked=["README.md"], findings=[
                               dict(file="README.md", line=1, kind="path", target="bin/gone.sh", suggestion=None),
                               dict(file="README.md", line=2, kind="verb", target="gone", suggestion=None)])

    def test_one_loop_per_file_survives_changed_claims_and_repeated_runs(self):
        self.module.publish(self.report, "jbookout/fixture", self.forge)
        self.module.publish(self.report, "jbookout/fixture", self.forge)
        self.assertEqual(self.forge.writes, ["create"])
        self.assertIn("Owner: orchestrator", self.forge.issues[0]["body"])
        self.assertIn("bin/gone.sh", self.forge.issues[0]["body"])
        self.report["findings"] = self.report["findings"][:1]
        self.module.publish(self.report, "jbookout/fixture", self.forge)
        self.assertEqual(self.forge.writes, ["create", "update"])
        self.assertEqual(len(self.forge.issues), 1)

    def test_resolved_claims_clear_loop_and_recurring_drift_reopens_it(self):
        self.module.publish(self.report, "jbookout/fixture", self.forge)
        self.report["findings"] = []
        self.module.publish(self.report, "jbookout/fixture", self.forge)
        self.assertEqual(self.forge.issues[0]["state"], "closed")
        self.report["findings"] = [dict(file="README.md", line=9, kind="path", target="new-missing.md", suggestion=None)]
        self.module.publish(self.report, "jbookout/fixture", self.forge)
        self.assertEqual(self.forge.issues[0]["state"], "open")
        self.assertEqual(len(self.forge.issues), 1)

    def test_partial_report_never_clears_loops(self):
        self.report["scope"] = "pr"
        with self.assertRaises(ValueError):
            self.module.publish(self.report, "jbookout/fixture", self.forge)
        self.assertFalse(self.forge.writes)


if __name__ == "__main__":
    unittest.main()
