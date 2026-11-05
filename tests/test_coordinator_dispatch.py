import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'bin/coordinator-dispatch.py'


class DispatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.carr = self.root / 'carr'
        self.carr.mkdir()
        self.log = self.carr / 'calls.jsonl'
        self.runner = self.carr / 'run.sh'
        self.runner.write_text('''#!/usr/bin/env python3
import json, pathlib, sys
root = pathlib.Path(__file__).parent
with (root / 'calls.jsonl').open('a') as out:
    out.write(json.dumps(sys.argv[1:]) + '\\n')
response = root / 'response.json'
print(response.read_text())
sys.exit(0 if json.loads(response.read_text()).get('ok') else 1)
''')
        self.runner.chmod(0o755)
        self.fixture = json.loads((ROOT / 'tests/fixtures/dispatch/mint.json').read_text())
        self.reply = self.fixture['response']
        self.response(self.reply)
        self.request = json.loads((ROOT / 'tests/fixtures/dispatch/request.json').read_text())
        self.input = self.root / 'request.json'
        self.temp = self.root / 'tmp'
        self.archive = self.root / 'briefs'

    def response(self, reply):
        (self.carr / 'response.json').write_text(json.dumps(reply))

    def command(self):
        return [sys.executable, str(CLI), str(self.input), '--carr-root', str(self.carr),
                '--tmp-dir', str(self.temp), '--brief-dir', str(self.archive)]

    def run_cli(self):
        self.input.write_text(json.dumps(self.request))
        return subprocess.run(self.command(), capture_output=True, text=True, timeout=10)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_mints_and_publishes_one_line(self):
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        card, path = result.stdout.strip().split(' ', 1)
        self.assertEqual(card, self.reply['card_id'])
        brief = Path(path).read_text()
        self.assertEqual(brief, (self.archive / Path(path).name).read_text())
        self.assertEqual([line for line in brief.splitlines() if line.startswith('Card:')], [f'Card: {card}'])
        self.assertIn(self.request['variables']['goal'], brief)
        self.assertEqual(self.calls()[0][:2], ['call', 'dispatch-job'])
        self.assertEqual(json.loads(self.calls()[0][2]), self.request['card'])
        self.assertEqual(len(self.calls()), 1)

    def test_all_templates(self):
        for template, extra in [('build', {}), ('review', {'pr_url': 'https://github.com/example/repo/pull/1', 'head_sha': 'a' * 40}), ('fix', {'findings': 'Repair synthetic failure.', 'pr_url': 'https://github.com/example/repo/pull/1'}), ('open-held-branch', {'branch': 'held-feature'})]:
            with self.subTest(template=template):
                self.request['template'] = template
                self.request['variables'].update(extra)
                self.request['card']['idempotency_key'] = str(uuid4())
                self.reply['card_id'] = f'WR622.S13.J{len(self.calls()) + 20}'
                self.response(self.reply)
                result = self.run_cli()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('Start no subagents.', Path(result.stdout.strip().split(' ', 1)[1]).read_text())

    def test_preflight_refuses_before_mint(self):
        for mutation in [lambda: self.request.update(template='../build'), lambda: self.request['variables'].pop('goal'), lambda: self.request['variables'].update(goal='Card: WR1.S1.J1'), lambda: self.request['card'].update(idempotency_key='not-a-uuid'), lambda: self.request['card'].update(runner_job_id='forbidden')]:
            with self.subTest(mutation=mutation):
                original = json.loads(json.dumps(self.request))
                mutation()
                result = self.run_cli()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')
                self.assertEqual(self.calls(), [])
                self.request = original

    def test_refusal_and_malformed_success_do_not_publish(self):
        for reply in [{'ok': False, 'error': 'refused'}, {'ok': True}, {'ok': True, 'card_id': '../../bad'}, {'ok': True, 'card_id': 'WR999.S13.J2'}]:
            self.response(reply)
            result = self.run_cli()
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')
            self.assertEqual(list(self.temp.glob('*.md')), [])

    def test_retry_repairs_missing_copy_and_rejects_changed_request(self):
        first = self.run_cli()
        self.assertEqual(first.returncode, 0, first.stderr)
        path = Path(first.stdout.strip().split(' ', 1)[1])
        path.unlink()
        second = self.run_cli()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(first.stdout, second.stdout)
        self.assertTrue(path.exists())
        self.request['variables']['goal'] = 'Different work'
        changed = self.run_cli()
        self.assertNotEqual(changed.returncode, 0)
        self.assertEqual(len(self.calls()), 1)

    def test_timeout_does_not_publish_or_retry(self):
        self.runner.write_text('#!/usr/bin/env python3\nimport time\ntime.sleep(1)\n')
        self.input.write_text(json.dumps(self.request))
        result = subprocess.run(self.command() + ['--timeout', '0.05'], capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('same UUID', result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertEqual(list(self.temp.glob('*.md')), [])

    def test_literal_variables_are_not_executed_or_expanded(self):
        self.request['variables']['goal'] = '$(touch sentinel) `touch sentinel` {{unknown}}'
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(self.request['variables']['goal'], Path(result.stdout.strip().split(' ', 1)[1]).read_text())
        self.assertFalse((self.carr / 'sentinel').exists())

    def test_concurrent_same_request_refuses_without_second_mint(self):
        import fcntl
        self.assertEqual(self.run_cli().returncode, 0)
        receipt = self.archive / '.requests' / (self.request['card']['idempotency_key'] + '.json')
        with receipt.open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.calls()), 1)
        self.assertIn('already running', result.stderr)

    def test_partial_publish_repairs_on_same_key_retry(self):
        self.archive.mkdir()
        path = self.archive / f"brief-{self.reply['card_id']}.md"
        path.mkdir()
        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)
        self.assertEqual(first.stdout, '')
        path.rmdir()
        self.assertEqual(self.run_cli().returncode, 0)

    def test_corrupt_receipt_refuses_before_mint(self):
        self.assertEqual(self.run_cli().returncode, 0)
        receipt = self.archive / '.requests' / (self.request['card']['idempotency_key'] + '.json')
        receipt.write_text('{')
        result = self.run_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertEqual(len(self.calls()), 1)

    def test_invalid_json_response_refuses(self):
        (self.carr / 'response.json').write_text('not JSON')
        result = self.run_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertEqual(list(self.temp.glob('*.md')), [])

    def test_file_conflict_refuses_without_success(self):
        self.archive.mkdir()
        path = self.archive / f"brief-{self.reply['card_id']}.md"
        path.write_text('existing other work')
        result = self.run_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertEqual(path.read_text(), 'existing other work')


if __name__ == '__main__':
    unittest.main()
