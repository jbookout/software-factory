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
    def test_every_required_tool_runs_and_rejects_failure_missing_and_timeout(self):
        for profile, contract in c.PROFILES.items():
            for tool in contract['tools']:
                with self.subTest(profile=profile, tool=tool), tempfile.TemporaryDirectory() as directory:
                    binary = Path(directory) / tool
                    with patch.dict(os.environ, PATH=directory):
                        with self.assertRaises((ValueError, FileNotFoundError)):
                            c.check_tools([tool])
                        binary.write_text('#!/bin/sh\nexit 42\n')
                        binary.chmod(0o755)
                        with self.assertRaises(subprocess.CalledProcessError) as failed:
                            c.check_tools([tool])
                        self.assertEqual(failed.exception.returncode, 42)
                        binary.write_text('#!/bin/sh\nexec /bin/sleep 2\n')
                        with patch.object(c, 'PROBE_TIMEOUT', 0.05, create=True):
                            with self.assertRaises(subprocess.TimeoutExpired):
                                c.check_tools([tool])
                        binary.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
                        observed = c.check_tools([tool])
                        self.assertEqual(observed[tool].splitlines(), list(c.TOOL_PROBES[tool]))

    def test_unknown_tool_has_no_discovery_only_fallback(self):
        with patch.object(c.shutil, 'which', return_value='/bin/true'):
            with self.assertRaisesRegex(ValueError, 'probe'):
                c.check_tools(['undeclared-probe'])

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
            manifest = json.dumps({'contract': c.PROFILES['browser'],
                                   'observed': {'tools': dict.fromkeys(c.PROFILES['browser']['tools'], 'ok')}})
            docker.write_text('#!/bin/sh\nif [ "$1" = run ]; then cat <<\'JSON\'\n' + manifest + '\nJSON\nelse echo ' + image_id + '; fi\n')
            docker.chmod(0o755)
            args = [sys.executable, str(Path(c.__file__)), 'preflight', 'browser',
                    '--image', 'candidate', '--commit', 'c'*40, '--directory', directory]
            environment = dict(os.environ, PATH=directory + os.pathsep + os.environ['PATH'])
            good = subprocess.run(args, capture_output=True, text=True, env=environment)
            self.assertEqual(good.returncode, 0, good.stderr)
            self.assertFalse((root / 'pin.json').exists())
            legacy = json.dumps({'contract': c.PROFILES['browser'], 'observed': {}})
            docker.write_text('#!/bin/sh\nif [ "$1" = run ]; then cat <<\'JSON\'\n' + legacy + '\nJSON\nelse echo ' + image_id + '; fi\n')
            refused = subprocess.run(args, capture_output=True, text=True, env=environment)
            self.assertEqual(refused.returncode, 1, refused.stderr)
            self.assertIn('every required tool probe', refused.stderr)
            docker.write_text('#!/bin/sh\nif [ "$1" = run ]; then exit 42; fi\necho ' + image_id + '\n')
            refused = subprocess.run(args, capture_output=True, text=True, env=environment)
            self.assertEqual(refused.returncode, 1, refused.stderr)
            self.assertIn('42', refused.stderr)
            self.assertFalse((root / 'pin.json').exists())
            (root / 'manifest.json').write_text('{"tampered":true}')
            bad = subprocess.run(args, capture_output=True, text=True, env=environment)
            self.assertEqual(bad.returncode, 1, bad.stderr)
            self.assertIn('wrong manifest.json', bad.stderr)
            self.assertFalse((root / 'pin.json').exists())


if __name__ == '__main__':
    unittest.main()
