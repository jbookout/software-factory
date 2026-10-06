import importlib.util
from pathlib import Path
import unittest


MODULE = Path(__file__).resolve().parents[2] / "scripts/doc-drift/loops.py"


class Forge:
    def __init__(self):
        self.issues = []
        self.writes = []

    def binding(self):
        return dict(repository='jbookout/fixture', source_sha='a' * 40,
                    files=['README.md'])

    def owns(self, issue):
        return (issue.get('user', {}).get('login') == 'github-actions[bot]'
                and issue.get('user', {}).get('type') == 'Bot'
                and 'instruction-drift' in [label['name'] for label in issue.get('labels', [])])

    def list(self):
        return self.issues

    def create(self, title, body):
        self.issues.append(dict(number=len(self.issues) + 1, title=title, body=body, state="open",
                                user=dict(login='github-actions[bot]', type='Bot'),
                                labels=[dict(name='instruction-drift')]))
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
                           repository="jbookout/fixture", scope="full", files_checked=["README.md"], findings=[
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


    def test_empty_coverage_never_clears_existing_loop(self):
        self.module.publish(self.report, 'jbookout/fixture', self.forge)
        self.report.update(files_checked=[], findings=[])
        with self.assertRaises(ValueError):
            self.module.publish(self.report, 'jbookout/fixture', self.forge)
        self.assertEqual(self.forge.writes, ['create'])
        self.assertEqual(self.forge.issues[0]['state'], 'open')

    def test_stale_revision_or_wrong_repository_never_writes(self):
        for field, value in [('source_sha', 'b' * 40), ('repository', 'jbookout/other')]:
            with self.subTest(field=field):
                report = dict(self.report, **{field: value})
                with self.assertRaises(ValueError):
                    self.module.publish(report, 'jbookout/fixture', self.forge)
        self.assertFalse(self.forge.writes)

    def test_partial_full_scan_never_writes(self):
        self.forge.binding = lambda: dict(repository='jbookout/fixture', source_sha='a' * 40,
                                          files=['README.md', 'guide.md'])
        with self.assertRaises(ValueError):
            self.module.publish(self.report, 'jbookout/fixture', self.forge)
        self.assertFalse(self.forge.writes)

    def test_verified_document_deletion_clears_loop(self):
        self.module.publish(self.report, 'jbookout/fixture', self.forge)
        self.forge.binding = lambda: dict(repository='jbookout/fixture', source_sha='b' * 40,
                                          files=['other.py'])
        self.report.update(source_sha='b' * 40, files_checked=[], findings=[])
        self.module.publish(self.report, 'jbookout/fixture', self.forge)
        self.assertEqual(self.forge.issues[0]['state'], 'closed')

    def test_copied_markers_on_human_issues_are_ignored(self):
        self.module.publish(self.report, 'jbookout/fixture', self.forge)
        copied = dict(self.forge.issues[0], number=2, user=dict(login='someone', type='User'))
        self.forge.issues.append(copied)
        self.module.publish(self.report, 'jbookout/fixture', self.forge)
        self.assertEqual(self.forge.writes, ['create'])
        self.report['findings'] = []
        self.module.publish(self.report, 'jbookout/fixture', self.forge)
        self.assertEqual(copied['state'], 'open')

    def test_bot_issue_without_publisher_label_is_ignored(self):
        self.forge.issues.append(dict(number=1, body=self.module.marker('jbookout/fixture', 'other.md'),
                                     state='open', user=dict(login='github-actions[bot]', type='Bot'), labels=[]))
        self.module.publish(self.report, 'jbookout/fixture', self.forge)
        self.assertEqual(self.forge.issues[0]['state'], 'open')


    def test_github_binding_refuses_truncated_authority(self):
        github = self.module.GitHub('jbookout/fixture', False)
        responses = [dict(object=dict(sha='a' * 40)), dict(tree=dict(sha='b' * 40)),
                     dict(truncated=True, tree=[])]
        github.api = lambda *args: responses.pop(0)
        with self.assertRaises(ValueError):
            github.binding()

    def test_github_binding_and_ownership_use_forge_metadata(self):
        github = self.module.GitHub('jbookout/fixture', False)
        responses = [dict(object=dict(sha='a' * 40)), dict(tree=dict(sha='b' * 40)),
                     dict(truncated=False, tree=[dict(path='README.md', type='blob'),
                                                dict(path='dir', type='tree')])]
        github.api = lambda *args: responses.pop(0)
        self.assertEqual(github.binding(), self.forge.binding())
        self.module.publish(self.report, 'jbookout/fixture', self.forge)
        self.assertTrue(github.owns(self.forge.issues[0]))
        self.assertFalse(github.owns(dict(self.forge.issues[0], labels=[])))

    def test_github_create_marks_issues_with_publisher_label(self):
        github = self.module.GitHub('jbookout/fixture', True)
        calls = []
        def api(suffix, method='GET', payload=None):
            calls.append((suffix, method, payload))
            return [dict(name='instruction-drift')] if suffix.startswith('labels?') else {}
        github.api = api
        github.create('drift', 'body')
        self.assertEqual(calls[-1], ('issues', 'POST', dict(title='drift', body='body', labels=['instruction-drift'])))


if __name__ == "__main__":
    unittest.main()
