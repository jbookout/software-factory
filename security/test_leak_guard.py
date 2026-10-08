import json
import base64
import hashlib
import os
import pathlib
import subprocess
import unittest
import uuid


SCRIPT = pathlib.Path(__file__).with_name('leak_guard.py')


class LeakGuardTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(os.environ.get('LEAK_GUARD_TEST_ROOT', '/tmp/leak-guard-tests')) / str(uuid.uuid4())
        self.root.mkdir(parents=True, mode=0o700)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        self.env = dict(os.environ)

    def run_guard(self, *args):
        return subprocess.run(['python3', str(SCRIPT), '--root', str(self.root), *args],
                              env=self.env, capture_output=True, text=True)

    def commit(self):
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Synthetic', '-c',
                        'user.email=64207374+jbookout@users.noreply.github.com', 'commit', '-qm', 'test'],
                       check=True)
        return subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD']).decode().strip()

    def test_secret_blocks_without_echoing_value(self):
        value = 'ghp_' + base64.b64encode(bytes(range(27))).decode()
        (self.root / 'sample.txt').write_text('token = "' + value + '"\n')
        subprocess.run(['git', '-C', str(self.root), 'add', 'sample.txt'], check=True)
        result = self.run_guard('--staged', '--generic-only')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('sample.txt:1', result.stdout)
        self.assertNotIn(value, result.stdout + result.stderr)

    def test_private_export_and_generic_pii_are_blocked(self):
        name = 'Fictional' + ' Person'
        salt = '12' * 32
        corpus = {'schema': 'leak-guard-corpus.v1', 'salt': salt, 'lengths': [2],
                  'hashes': [hashlib.sha256((salt + '\0fictionalperson').encode()).hexdigest()]}
        corpus_path = self.root / 'corpus.json'
        corpus_path.write_text(json.dumps(corpus))
        values = [name, 'contact' + '@private.invalid', '(212)' + ' 234-6789', '843' + ' Imaginary Avenue']
        (self.root / 'sample.txt').write_text('\n'.join(values))
        subprocess.run(['git', '-C', str(self.root), 'add', 'sample.txt'], check=True)
        result = self.run_guard('--staged', '--corpus', str(corpus_path))
        self.assertEqual(result.returncode, 1, result.stderr)
        for line in range(1, 5):
            self.assertIn(f'sample.txt:{line}', result.stdout)
        for value in values:
            self.assertNotIn(value, result.stdout + result.stderr)

    def test_removed_secret_still_blocks_range_and_pre_push(self):
        (self.root / 'sample.txt').write_text('safe\n')
        subprocess.run(['git', '-C', str(self.root), 'add', 'sample.txt'], check=True)
        base = self.commit()
        value = 'ghp_' + base64.b64encode(bytes(range(27))).decode()
        (self.root / 'sample.txt').write_text('token="' + value + '"\n')
        subprocess.run(['git', '-C', str(self.root), 'add', 'sample.txt'], check=True)
        self.commit()
        (self.root / 'sample.txt').write_text('safe again\n')
        subprocess.run(['git', '-C', str(self.root), 'add', 'sample.txt'], check=True)
        head = self.commit()
        result = self.run_guard('--range', base + '..' + head, '--generic-only')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('sample.txt:1', result.stdout)
        refs = f'refs/heads/feature {head} refs/heads/feature {base}\n'
        hook = subprocess.run(['python3', str(SCRIPT), '--root', str(self.root), '--pre-push',
                               '--generic-only'], input=refs, env=self.env, capture_output=True, text=True)
        self.assertEqual(hook.returncode, 1, hook.stderr)
        self.assertNotIn(value, result.stdout + hook.stdout + hook.stderr)

    def test_allowlist_is_bound_to_fixture_bytes_and_requires_reason(self):
        raw = ('test' + '@synthetic.invalid\n').encode()
        (self.root / 'fixture.txt').write_bytes(raw)
        subprocess.run(['git', '-C', str(self.root), 'add', 'fixture.txt'], check=True)
        allow = self.root / 'allow.json'
        entry = {'path': 'fixture.txt', 'sha256': hashlib.sha256(raw).hexdigest(),
                 'rule': 'pii-email', 'reason': 'Synthetic email for detector qualification.'}
        allow.write_text(json.dumps({'schema': 'leak-guard-allowlist.v1', 'entries': [entry]}))
        result = self.run_guard('--staged', '--generic-only', '--allowlist', str(allow))
        self.assertEqual(result.returncode, 0, result.stderr)
        (self.root / 'fixture.txt').write_bytes(raw + b'changed\n')
        subprocess.run(['git', '-C', str(self.root), 'add', 'fixture.txt'], check=True)
        result = self.run_guard('--staged', '--generic-only', '--allowlist', str(allow))
        self.assertEqual(result.returncode, 1, result.stderr)
        entry['reason'] = ''
        allow.write_text(json.dumps({'schema': 'leak-guard-allowlist.v1', 'entries': [entry]}))
        result = self.run_guard('--staged', '--generic-only', '--allowlist', str(allow))
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_hash_export_contains_no_original_values(self):
        values = ['Fictional' + ' Person', 'contact' + '@private.invalid', '843' + ' Imaginary Avenue']
        exporter = SCRIPT.with_name('hash_export.py')
        result = subprocess.run(['python3', str(exporter)], input=json.dumps({'values': values}),
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        corpus = json.loads(result.stdout)
        self.assertEqual(corpus['schema'], 'leak-guard-corpus.v1')
        self.assertEqual(len(corpus['hashes']), 3)
        for value in values:
            self.assertNotIn(value, result.stdout)

    def test_non_latin_name_export_and_detection_preserve_letters(self):
        value = chr(0x6f22) + chr(0x5b57)
        export = subprocess.run(['python3', str(SCRIPT.with_name('hash_export.py'))],
                                input=json.dumps({'values': [value]}), capture_output=True, text=True)
        self.assertEqual(export.returncode, 0, export.stderr)
        corpus = self.root / 'corpus.json'
        corpus.write_text(export.stdout)
        (self.root / 'sample.txt').write_text(value + '\n')
        subprocess.run(['git', '-C', str(self.root), 'add', 'sample.txt'], check=True)
        result = self.run_guard('--staged', '--corpus', str(corpus))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('sample.txt:1 client-data', result.stdout)
        self.assertTrue(value not in result.stdout + result.stderr, 'Matched value escaped diagnostics')

    def test_export_indexes_only_possible_lengths_for_each_hashed_start(self):
        exporter = SCRIPT.with_name('hash_export.py')
        result = subprocess.run(['python3', str(exporter)], input=json.dumps({'values': ['Fictional', 'Imaginary' + ' Customer']}), capture_output=True, text=True)
        corpus = json.loads(result.stdout)
        self.assertEqual(sorted(corpus['start_lengths'].values()), [[1], [2]])
        self.assertTrue(all(len(key) == 64 for key in corpus['start_lengths']))

    def test_utf16_secret_and_sensitive_filename_are_blocked(self):
        value = 'ghp_' + base64.b64encode(bytes(range(27))).decode()
        (self.root / 'sample.txt').write_bytes(('token="' + value + '"\n').encode('utf-16'))
        filename = 'wrapped\n' + value
        (self.root / filename).write_text('safe\n')
        subprocess.run(['git', '-C', str(self.root), 'add', 'sample.txt', filename], check=True)
        result = self.run_guard('--staged', '--generic-only')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue(value not in result.stdout + result.stderr, 'Matched filename value escaped diagnostics')
        self.assertIn('sample.txt:1', result.stdout)
        self.assertIn('[redacted-path:', result.stdout)

    def test_missing_corpus_and_binary_refuse_without_values(self):
        (self.root / 'asset.dat').write_bytes(b'opaque\0content')
        subprocess.run(['git', '-C', str(self.root), 'add', 'asset.dat'], check=True)
        result = self.run_guard('--staged', '--generic-only')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('asset.dat:1 opaque-binary', result.stdout)
        result = self.run_guard('--staged', '--corpus', str(self.root / 'missing.json'))
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_private_history_report_contains_counts_and_paths_only(self):
        (self.root / '.gitignore').write_text('out/\n')
        (self.root / 'sample.txt').write_text('contact' + '@private.invalid\n')
        subprocess.run(['git', '-C', str(self.root), 'add', '.gitignore', 'sample.txt'], check=True)
        self.commit()
        report = self.root / 'out/history.json'
        result = self.run_guard('--history', '--generic-only', '--report', str(report))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, '')
        data = json.loads(report.read_text())
        self.assertEqual(set(data), {'schema', 'counts', 'files'})
        self.assertEqual(data['counts'], {'pii-email': 1})
        self.assertEqual(data['files'], {'sample.txt': 1})

    def test_client_exception_only_allows_its_specific_hash(self):
        salt = '12' * 32
        first = 'Fictional' + ' Person'
        second = 'Imaginary' + ' Customer'
        hashes = [hashlib.sha256((salt + '\0' + word).encode()).hexdigest()
                  for word in ('fictionalperson', 'imaginarycustomer')]
        corpus = self.root / 'corpus.json'
        corpus.write_text(json.dumps({'schema': 'leak-guard-corpus.v1', 'salt': salt, 'lengths': [2], 'hashes': hashes}))
        raw = (first + '\n' + second + '\n').encode()
        (self.root / 'fixture.txt').write_bytes(raw)
        subprocess.run(['git', '-C', str(self.root), 'add', 'fixture.txt'], check=True)
        allow = self.root / 'allow.json'
        allow.write_text(json.dumps({'schema': 'leak-guard-allowlist.v1', 'entries': [{
            'path': 'fixture.txt', 'sha256': hashlib.sha256(raw).hexdigest(), 'rule': 'client-data',
            'value_sha256': hashes[0], 'reason': 'Synthetic overlap for qualification.'}]}))
        result = self.run_guard('--staged', '--corpus', str(corpus), '--allowlist', str(allow))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertNotIn('fixture.txt:1', result.stdout)
        self.assertIn('fixture.txt:2', result.stdout)

    def test_git_push_hook_refuses_seeded_secret_before_receiver_gets_it(self):
        (self.root / 'security').symlink_to(SCRIPT.parent, target_is_directory=True)
        subprocess.run(['git', '-C', str(self.root), 'config', 'core.hooksPath', str(SCRIPT.parent)], check=True)
        value = 'ghp_' + base64.b64encode(bytes(range(27))).decode()
        (self.root / 'sample.txt').write_text('token="' + value + '"\n')
        subprocess.run(['git', '-C', str(self.root), 'add', 'sample.txt'], check=True)
        self.commit()
        receiver = self.root / 'out/_to_delete/receiver.git'
        subprocess.run(['git', 'init', '--bare', '-q', str(receiver)], check=True)
        result = subprocess.run(['git', '-C', str(self.root), 'push', str(receiver), 'HEAD:refs/heads/seeded'],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn('sample.txt:1', result.stdout + result.stderr)
        self.assertNotIn(value, result.stdout + result.stderr)
        refs = subprocess.check_output(['git', '-C', str(receiver), 'for-each-ref'])
        self.assertEqual(refs, b'')

    def test_large_scan_bounds_each_gitleaks_input_batch(self):
        import importlib.util
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location('guard', SCRIPT)
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        run = subprocess.run
        sizes = []
        def observed_run(*args, **kwargs):
            if 'input' in kwargs:
                sizes.append(len(kwargs['input']))
            return run(*args, **kwargs)
        source = [(f'file-{i}.txt', b'x' * 1048576) for i in range(20)]
        with patch.object(guard.subprocess, 'run', side_effect=observed_run):
            self.assertEqual(guard.scan(self.root, source, None, set()), 0)
        self.assertGreater(len(sizes), 1)
        self.assertLessEqual(max(sizes), 9 * 1048576)

    def test_long_encoded_text_completes_without_quadratic_pii_search(self):
        (self.root / 'sample.txt').write_text('/' * 60000 + '\n')
        subprocess.run(['git', '-C', str(self.root), 'add', 'sample.txt'], check=True)
        result = subprocess.run(['python3', str(SCRIPT), '--root', str(self.root),
                                 '--staged', '--generic-only'], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
