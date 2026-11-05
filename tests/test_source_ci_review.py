import copy
import hashlib
from pathlib import Path
import tempfile
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import unittest

from lib.source_ci_review import Consumer, Binding, Launch, prove


def candidate(head='a' * 40):
    repo = 'DoctorCRE/carr-system'
    return dict(schema='carr-source-ci-review-candidate.v1', state='candidate',
                repository=repo, pull_request=42, head_sha=head, review_round=1,
                request_key=hashlib.sha256(f'{repo}:42:{head}:1'.encode()).hexdigest(),
                source_run_id=123, source_run_attempt=1)


class Host:
    def __init__(self):
        self.current = candidate()
        self.calls = []
        self.binding = Binding('WR823.S13.J1', 'builder-session',
                               'WR823.S13.J7', 'reviewer-session')
        self.fail = None

    def collect(self, run, attempt):
        self.calls.append('collect')
        return copy.deepcopy(self.current)

    def admit(self, item, key):
        self.calls.append('admit')
        if self.fail == 'admit':
            raise TimeoutError()
        return self.binding

    def launch(self, request, binding):
        assert binding == self.binding
        self.calls.append(request)
        if self.fail == 'launch':
            raise TimeoutError()
        return Launch('task-1', 'thread-1')


class Admission(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'jobs.sqlite'
        self.host = Host()

    def consume(self, item=None):
        with Consumer(self.path, 'b' * 40) as consumer:
            return consumer.consume(item or candidate(), self.host)

    def test_green_source_launches_with_card_and_no_review_gate(self):
        receipt = self.consume()
        self.assertEqual(receipt['state'], 'launched')
        request = self.host.calls[-1]
        self.assertEqual(request['clientRequestId'], candidate()['request_key'])
        self.assertEqual(request['role'], 'review')
        self.assertEqual(request['isolation'], 'worktree')
        self.assertEqual(request['task'].splitlines().count('Card: WR823.S13.J7'), 1)
        self.assertEqual(receipt['binding']['builder_executor'], 'builder-session')
        self.assertTrue(prove(receipt, candidate(), 'b' * 40))

    def test_duplicate_after_restart_and_ci_rerun_launch_once(self):
        self.consume()
        self.host.current['source_run_attempt'] = 2
        self.consume(self.host.current)
        self.assertEqual(self.host.calls.count('admit'), 1)
        self.assertEqual(len([c for c in self.host.calls if isinstance(c, dict)]), 1)

    def test_moved_head_and_forged_artifact_never_admit(self):
        self.host.current = candidate('c' * 40)
        self.assertEqual(self.consume()['state'], 'refused')
        self.assertNotIn('admit', self.host.calls)

    def test_failed_or_refused_collector_never_admits(self):
        self.host.current = {'state': 'refused'}
        self.assertEqual(self.consume()['state'], 'refused')
        self.assertNotIn('admit', self.host.calls)

    def test_independence_and_card_validation(self):
        for binding in (Binding('WR823.S13.J1', 'same', 'WR823.S13.J7', 'same'),
                        Binding('WR823.S13.J1', 'a', 'WR823.S13.J1', 'b'),
                        Binding('unknown', 'a', 'WR823.S13.J7', 'b')):
            self.host.binding = binding
            self.assertEqual(self.consume()['state'], 'held')
            self.assertFalse(any(isinstance(c, dict) for c in self.host.calls))

    def test_uncertain_admission_or_launch_is_held_without_retry(self):
        for fail in ('admit', 'launch'):
            with self.subTest(fail=fail):
                self.path = Path(self.temp.name) / f'{fail}.sqlite'
                self.host = Host()
                self.host.fail = fail
                self.assertEqual(self.consume()['state'], 'held')
                self.consume()
                self.assertEqual(self.host.calls.count('admit'), 1)

    def test_head_moves_during_admission(self):
        original = self.host.admit
        def admit(item, key):
            result = original(item, key)
            self.host.current = candidate('c' * 40)
            return result
        self.host.admit = admit
        self.assertEqual(self.consume()['state'], 'superseded')
        self.assertFalse(any(isinstance(c, dict) for c in self.host.calls))

    def test_recheck_failure_holds_without_launch(self):
        collect = self.host.collect
        def fail(run, attempt):
            if 'admit' in self.host.calls:
                raise TimeoutError()
            return collect(run, attempt)
        self.host.collect = fail
        self.assertEqual(self.consume()['state'], 'held')
        self.assertFalse(any(isinstance(c, dict) for c in self.host.calls))

    def test_concurrent_duplicates_have_one_owner(self):
        barrier = Barrier(4)
        collect = self.host.collect
        def first_collect(run, attempt):
            result = collect(run, attempt)
            if len(self.host.calls) <= 4:
                barrier.wait(timeout=5)
            return result
        self.host.collect = first_collect
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.consume(), range(4)))
        self.assertTrue(all(r['state'] in ('admitting', 'admitted', 'launching', 'launched') for r in results))
        self.assertEqual(self.consume()['state'], 'launched')
        self.assertEqual(self.host.calls.count('admit'), 1)

    def test_new_head_gets_independent_review(self):
        self.consume()
        self.host.current = candidate('c' * 40)
        self.assertEqual(self.consume(self.host.current)['state'], 'launched')
        self.assertEqual(self.host.calls.count('admit'), 2)

    def test_crash_before_and_after_paid_acceptance_never_relaunches(self):
        def crash(request, binding):
            self.host.calls.append(request)
            raise KeyboardInterrupt()
        self.host.launch = crash
        with self.assertRaises(KeyboardInterrupt):
            self.consume()
        self.assertEqual(self.consume()['state'], 'launching')
        self.assertEqual(len([c for c in self.host.calls if isinstance(c, dict)]), 1)

    def test_process_death_during_admission_never_mints_another_card(self):
        def crash(item, key):
            self.host.calls.append('admit')
            raise KeyboardInterrupt()
        self.host.admit = crash
        with self.assertRaises(KeyboardInterrupt):
            self.consume()
        self.assertEqual(self.consume()['state'], 'admitting')
        self.assertEqual(self.host.calls.count('admit'), 1)

    def test_process_death_after_card_persist_never_relaunches(self):
        collect = self.host.collect
        def crash(run, attempt):
            if 'admit' in self.host.calls:
                raise KeyboardInterrupt()
            return collect(run, attempt)
        self.host.collect = crash
        with self.assertRaises(KeyboardInterrupt):
            self.consume()
        self.assertEqual(self.consume()['state'], 'admitted')
        self.assertEqual(self.host.calls.count('admit'), 1)

    def test_cli_receipt_proof_pass_and_failure(self):
        root = Path(__file__).resolve().parents[1]
        cli = root / 'tools/source-ci-review.py'
        receipt = self.consume()
        candidate_file = Path(self.temp.name) / 'candidate.json'
        receipt_file = Path(self.temp.name) / 'receipt.json'
        candidate_file.write_text(json.dumps(candidate()))
        receipt_file.write_text(json.dumps(receipt))
        command = [sys.executable, str(cli), 'prove', '--candidate', str(candidate_file),
                   '--receipt', str(receipt_file), '--revision', 'b' * 40]
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(json.loads(result.stdout)['remote_execution_verified'])
        receipt['state'] = 'launching'
        receipt_file.write_text(json.dumps(receipt))
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        result = subprocess.run([sys.executable, str(cli), 'receipt', '--store', str(self.path),
                                 '--key', candidate()['request_key']],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['launch'], receipt['launch'])

    def test_bad_input_and_proof_fail_closed(self):
        for key, value in [('review_round', 2), ('request_key', 'x'),
                           ('pull_request', True), ('head_sha', '../x')]:
            item = candidate()
            item[key] = value
            with self.assertRaises(ValueError):
                self.consume(item)
        self.assertEqual(self.host.calls, [])
        receipt = self.consume()
        for key in ('binding', 'launch', 'launcher_revision'):
            bad = copy.deepcopy(receipt)
            del bad[key]
            self.assertFalse(prove(bad, candidate(), 'b' * 40))
        self.assertFalse(prove(receipt, candidate('c' * 40), 'b' * 40))


if __name__ == '__main__':
    unittest.main()
