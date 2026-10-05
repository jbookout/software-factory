import json
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[2]


class CiTest(unittest.TestCase):
    def test_pinned_product_copy_refuses_modified_bytes(self):
        spec = importlib.util.spec_from_file_location('doc_drift_ci', ROOT / 'scripts/doc-drift/ci.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        scratch = Path(tempfile.mkdtemp(prefix='doc-drift-pin-fixture-'))
        (scratch / 'scripts/doc-drift').mkdir(parents=True)
        (scratch / 'tool.py').write_text('changed')
        (scratch / 'scripts/doc-drift/source.json').write_text(json.dumps(dict(
            repository='jbookout/software-factory', revision='a' * 40,
            files={'tool.py': '0' * 64})))
        with self.assertRaises(ValueError):
            module.verify_snapshot(scratch)

    def test_pr_warnings_and_weekly_writer_have_distinct_authority(self):
        workflow = yaml.load((ROOT / '.github/workflows/doc-drift.yml').read_text(), Loader=yaml.BaseLoader)
        self.assertIn('schedule', workflow['on'])
        self.assertIn('pull_request', workflow['on'])
        self.assertNotIn('issues', workflow['permissions'])
        writer = workflow['jobs']['weekly-loops']
        self.assertEqual(writer['permissions']['issues'], 'write')
        self.assertIn("github.event_name != 'pull_request'", writer['if'])
        self.assertIn("github.ref == 'refs/heads/main'", writer['if'])
        self.assertEqual(writer['needs'], 'check')

    @unittest.skipUnless((ROOT / 'ops/ci.sh').exists(), 'CARR owns the single CI script')
    def test_carr_ci_entrypoint_forwards_arguments_to_local_checker(self):
        scratch = Path(tempfile.mkdtemp(prefix='doc-drift-ci-fixture-'))
        executable = scratch / 'python'
        executable.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
        executable.chmod(0o755)
        env = dict(os.environ, CARR_DOC_DRIFT_PYTHON=str(executable))
        result = subprocess.run(['bash', str(ROOT / 'ops/ci.sh'), '--doc-drift', '--base', 'abc123'],
                                env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [str(ROOT / 'scripts/doc-drift/ci.py'), '--base', 'abc123'])


if __name__ == '__main__':
    unittest.main()
