"""Capability contracts fail closed before publication."""
import importlib.util
from pathlib import Path
import tempfile
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('capabilities', Path(__file__).with_name('capabilities.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class CapabilityTests(unittest.TestCase):
    def test_versions_are_exact(self):
        for actual in ('v26.12.0', 'v26.12.10', ''):
            with self.assertRaises(ValueError):
                c.require_version('node', actual, 'v26.12.1')
        c.require_version('node', 'v26.12.1', 'v26.12.1')

    def test_missing_tool_refuses_without_installation(self):
        with patch.object(c.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(ValueError, 'missing.*zsh'):
                c.check_tools(['zsh'])

    def test_failed_candidate_never_creates_pin(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'pin.json'
            for receipt in ({}, {'profile': 'browser', 'image_id': 'sha256:' + 'a'*64}):
                with self.assertRaises(ValueError):
                    c.promote('browser', receipt, 'sha256:' + 'a'*64,
                              'sha256:' + 'b'*64, 'c'*40, output)
                self.assertFalse(output.exists())

    def test_promotion_binds_qualified_bytes_and_recipe(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'pin.json'
            receipt = {'profile': 'browser', 'image_id': 'sha256:' + 'a'*64,
                       'recipe_commit': 'c'*40, 'offline': True,
                       'manifest_sha256': 'd'*64, 'sbom_sha256': 'e'*64}
            c.promote('browser', receipt, receipt['image_id'], 'sha256:' + 'b'*64, 'c'*40, output)
            self.assertIn('@sha256:', output.read_text())
            for field, wrong in [('image_id', 'sha256:'+'f'*64), ('recipe_commit', 'f'*40), ('offline', False)]:
                with self.subTest(field=field), self.assertRaises(ValueError):
                    c.promote('browser', dict(receipt, **{field: wrong}), receipt['image_id'],
                              'sha256:'+'b'*64, 'c'*40, output)
            with self.assertRaises(ValueError):
                c.promote('browser', receipt, receipt['image_id'], 'latest', 'c'*40, output)

    def test_preflight_cli_checks_artifact_hashes_before_any_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('manifest.json', 'sbom.spdx.json'):
                (root / name).write_text('{}')
            image_id = 'sha256:' + 'a'*64
            receipt = {'profile': 'browser', 'image_id': image_id,
                       'recipe_commit': 'c'*40, 'offline': True,
                       'manifest_sha256': c.digest(root / 'manifest.json'),
                       'sbom_sha256': c.digest(root / 'sbom.spdx.json')}
            (root / 'qualification.json').write_text(json.dumps(receipt))
            docker = root / 'docker'
            docker.write_text('#!/bin/sh\necho ' + image_id + '\n')
            docker.chmod(0o755)
            args = [sys.executable, str(Path(c.__file__)), 'preflight', 'browser',
                    '--image', 'candidate', '--commit', 'c'*40, '--directory', directory]
            environment = dict(os.environ, PATH=directory + os.pathsep + os.environ['PATH'])
            good = subprocess.run(args, capture_output=True, text=True, env=environment)
            self.assertEqual(good.returncode, 0, good.stderr)
            self.assertFalse((root / 'pin.json').exists())
            (root / 'manifest.json').write_text('{"tampered":true}')
            bad = subprocess.run(args, capture_output=True, text=True, env=environment)
            self.assertEqual(bad.returncode, 1, bad.stderr)
            self.assertIn('wrong manifest.json', bad.stderr)
            self.assertFalse((root / 'pin.json').exists())


if __name__ == '__main__':
    unittest.main()
