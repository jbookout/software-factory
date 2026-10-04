import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('audit', ROOT / 'scripts/orch/audit-workflows.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

CLEAN = '''name: Test
on: [pull_request, push]
permissions:
  contents: read
jobs:
  test:
    timeout-minutes: 15
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      - run: echo test
'''


class PracticeAudit(unittest.TestCase):
    def run_audit(self, text, required=('test',)):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.github/workflows/ci.yml'
            path.parent.mkdir(parents=True)
            path.write_text(text)
            return audit.audit(directory, [{'workflow': '.github/workflows/ci.yml', 'job': job} for job in required])

    def test_clean_configuration_never_claims_speedup(self):
        result = self.run_audit(CLEAN)
        self.assertFalse([f for f in result['properties'] if f['status'] == 'breach'])
        self.assertEqual(result['performance']['status'], 'unknown')
        self.assertNotIn('score', result)

    def test_exact_missing_timeout_unpinned_action_and_required_skip(self):
        cases = [(CLEAN.replace('    timeout-minutes: 15\n', ''), 'job-timeout', 7),
                 (CLEAN.replace('a' * 40, 'v4'), 'action-pin', 10),
                 (CLEAN.replace('    runs-on:', '    if: false\n    runs-on:'), 'required-unconditional', 8)]
        for text, property_name, line in cases:
            with self.subTest(property=property_name):
                result = self.run_audit(text)
                finding = next(f for f in result['properties'] if f['property'] == property_name and f['status'] == 'breach')
                self.assertEqual(finding['line'], line)
                for key in ['owner', 'remediation', 'test', 'clear']:
                    self.assertTrue(finding['response'][key])

    def test_privileged_fork_checkout_nested_and_alias(self):
        text = CLEAN.replace('on: [pull_request, push]', 'on: pull_request_target').replace(
            '      - uses:', '      - uses:', 1).replace('      - run:',
            '        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n      - run:')
        result = self.run_audit(text)
        self.assertTrue(any(f['property'] == 'privileged-checkout' and f['status'] == 'breach' for f in result['properties']))
        # No checkout of pull-request code has a documented negative relevance test.
        result = self.run_audit(CLEAN)
        self.assertTrue(any(f['property'] == 'privileged-checkout' and f['status'] == 'not-applicable' and f['evidence'] for f in result['properties']))

    def test_workflow_paths_skip_required_and_absent_workflow_unknown(self):
        text = CLEAN.replace('on: [pull_request, push]', 'on:\n  pull_request:\n    paths: [src/**]')
        result = self.run_audit(text)
        self.assertTrue(any(f['property'] == 'required-trigger' and f['status'] == 'breach' for f in result['properties']))
        with tempfile.TemporaryDirectory() as directory:
            result = audit.audit(directory, [{'workflow': '.github/workflows/missing.yml', 'job': 'strict'}])
            self.assertEqual(result['status'], 'unknown')

    def test_required_dependency_gate_needs_always_after_red(self):
        text = CLEAN.replace('    timeout-minutes:', '    needs: build\n    timeout-minutes:')
        result = self.run_audit(text)
        self.assertTrue(any(p['property'] == 'required-unconditional' and p['status'] == 'breach' for p in result['properties']))
        healthy = self.run_audit(text.replace('    needs:', '    if: ${{ always() }}\n    needs:'))
        self.assertFalse(any(p['property'] == 'required-unconditional' and p['status'] == 'breach' for p in healthy['properties']))

    def test_yaml_syntax_duplicate_keys_no_secret_diagnostic(self):
        for text in ['jobs: [SECRET-CANARY', 'jobs: {}\njobs: {}',
                     CLEAN.replace('  test:\n', '  test:\n    <<: {if: false}\n'),
                     'jobs: &cycle {job: *cycle}']:
            result = self.run_audit(text)
            self.assertEqual(result['status'], 'unknown')
            self.assertNotIn('SECRET-CANARY', str(result))

    def test_alias_checkout_detects_privileged_selection(self):
        text = CLEAN.replace('on: [pull_request, push]', 'on: pull_request_target').replace(
            '    steps:', '    strategy: &inputs\n      ref: ${{ github.event.pull_request.head.sha }}\n    steps:').replace(
            '      - run:', '        with: *inputs\n      - run:')
        self.assertTrue(any(p['property'] == 'privileged-checkout' and p['status'] == 'breach'
                            for p in self.run_audit(text)['properties']))

    def test_existing_property_one_owned_response_across_runs(self):
        bad = CLEAN.replace('    timeout-minutes: 15\n', '')
        first = self.run_audit(bad)
        second = self.run_audit(bad)
        self.assertEqual([f['response']['id'] for f in first['properties'] if f['status'] == 'breach'],
                         [f['response']['id'] for f in second['properties'] if f['status'] == 'breach'])


if __name__ == '__main__':
    unittest.main()
