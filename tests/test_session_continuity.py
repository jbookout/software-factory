import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'tools/session-continuity.py'
FIXTURES = ROOT / 'tests/fixtures/session-continuity'


def fixture():
    return json.loads((FIXTURES / 'codex-appserver.json').read_text())['envelope']


def run(event, store, *args):
    p = subprocess.run([sys.executable, str(CLI), '--store', str(store), *args],
                       input=json.dumps(event), text=True, capture_output=True)
    if p.returncode:
        raise AssertionError(p.stderr)
    return json.loads(p.stdout)


class ProcessBoundary(unittest.TestCase):
    def test_durable_checkpoint_and_recovery_across_processes(self):
        with tempfile.TemporaryDirectory(prefix='wr826-private-') as store:
            event = fixture()
            saved = run(event, store)
            self.assertEqual(saved['status'], 'saved')
            self.assertTrue(saved['receipt']['durable_readback'])
            self.assertEqual(saved['receipt']['native_delivery'], 'pending')
            recovered = run({'binding': event['binding']}, store, '--recover')
            self.assertEqual(recovered['checkpoint'], event['checkpoint'])
            self.assertEqual(recovered['receipt'], saved['receipt'])
            files = list(Path(store).glob('*/checkpoint.json'))
            self.assertEqual(len(files), 1)
            self.assertEqual(json.loads(files[0].read_text())['checkpoint'], event['checkpoint'])

class Counterfixtures(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wr826-private-')
        self.addCleanup(self.temp.cleanup)
        self.store = self.temp.name
        self.event = fixture()

    def usage(self, used, window=475000):
        self.event['payload']['tokenUsage']['last']['totalTokens'] = used
        self.event['payload']['tokenUsage']['modelContextWindow'] = window
        return run(self.event, self.store)

    def test_threshold_edges_and_lifetime_not_occupancy(self):
        for used, status in [(10000, 'continue'), (424999, 'continue'), (425000, 'saved'), (425001, 'saved')]:
            with self.subTest(used=used), tempfile.TemporaryDirectory() as store:
                self.store = store
                self.assertEqual(self.usage(used)['status'], status)

    def test_larger_window_only_when_safe(self):
        self.assertEqual(self.usage(499999, 600000)['status'], 'continue')
        self.assertEqual(self.usage(500000, 600000)['decision']['threshold'], 500000)

    def test_earlier_compaction_and_smaller_window(self):
        self.event['auto_compact_at'] = 400000
        self.assertEqual(self.usage(350000)['decision']['threshold'], 350000)
        self.event.pop('auto_compact_at')
        self.event['cursor'] = 2
        self.event['epoch'] = 2
        self.event['expected_generation'] = 1
        self.assertEqual(self.usage(208400, 258400)['decision']['threshold'], 208400)

    def test_unknown_counters_and_capacity(self):
        for field in ['totalTokens', 'modelContextWindow']:
            for value in [None, True, False, -1, '425000', 4.2, 'missing']:
                event = fixture()
                target = event['payload']['tokenUsage']['last'] if field == 'totalTokens' else event['payload']['tokenUsage']
                if value == 'missing':
                    target.pop(field)
                else:
                    target[field] = value
                with self.subTest(field=field, value=value):
                    self.assertEqual(run(event, self.store)['status'], 'unknown')
        event = fixture()
        event['payload']['tokenUsage'].pop('total')
        self.assertEqual(run(event, self.store)['status'], 'unknown')

    def test_stale_unknown_epoch_and_model_change(self):
        for field, value, reason in [('observed_at', 900, 'stale_usage'), ('observed_at', 1001, 'stale_usage'), ('epoch', None, 'unknown_epoch'), ('epoch', True, 'unknown_epoch'), ('epoch_evidence', '', 'unknown_epoch'), ('usage_model_fingerprint', 'other', 'model_changed')]:
            event = fixture()
            event[field] = value
            with self.subTest(field=field):
                self.assertEqual(run(event, self.store)['reason'], reason)

    def test_precompact_without_usage_all_roles(self):
        for role in ['coordinator', 'user', 'builder', 'reviewer', 'verifier', 't3-worker', 'native-subagent', 'remote-worker']:
            for provider in ['claude', 'codex', 'grok']:
                event = json.loads((FIXTURES / f'{provider}-hooks.json').read_text())['envelope']
                event['binding']['role'] = role
                with self.subTest(role=role, provider=provider), tempfile.TemporaryDirectory() as store:
                    result = run(event, store)
                    self.assertEqual(result['status'], 'saved')
                    self.assertEqual(result['decision']['protection'], 'unknown')
                    recovery = run({'binding': event['binding']}, store, '--recover')
                    self.assertEqual(recovery['receipt']['native_delivery'], 'pending')
                    if provider == 'claude':
                        self.assertEqual(recovery['recovery_output']['hookSpecificOutput']['hookEventName'], 'SessionStart')
                    else:
                        self.assertIsNone(recovery['recovery_output'])

    def test_latest_claude_and_grok_acp(self):
        for provider, name in [('claude', 'claude-usage'), ('grok', 'grok-acp'), ('codex', 'codex-native-metadata')]:
            event = json.loads((FIXTURES / f'{name}.json').read_text())['envelope']
            with self.subTest(provider=provider):
                self.assertEqual(run(event, self.store)['status'], 'continue')

    def test_duplicate_changed_replay_cas_epoch_reset_and_old_epoch(self):
        saved = run(self.event, self.store)
        self.assertEqual(saved['receipt'], run(self.event, self.store)['receipt'])
        changed = copy.deepcopy(self.event)
        changed['checkpoint']['next_action'] = 'different'
        self.assertEqual(run(changed, self.store)['reason'], 'changed_replay')
        self.event['cursor'] = 2
        self.assertEqual(run(self.event, self.store)['reason'], 'cas_conflict')
        self.event['expected_generation'] = 1
        self.event['kind'] = 'before_compact'
        self.event['binding']['harness'] = 'hooks'
        self.event['payload'] = {'hook_event_name': 'PreCompact', 'session_id': 'native-fixture', 'info': {'last_token_usage': {'total_tokens': 1000}, 'model_context_window': 475000}}
        # A separate native hook harness has a separate session store.
        first = run(self.event, self.store)
        self.assertEqual(first['reason'], 'cas_conflict')
        self.event['expected_generation'] = 0
        self.assertEqual(run(self.event, self.store)['status'], 'saved')
        self.event['cursor'] = 3
        self.event['expected_generation'] = 1
        self.event['payload']['info']['last_token_usage']['total_tokens'] = 1
        self.assertEqual(run(self.event, self.store)['reason'], 'counter_reset_without_new_epoch')
        self.event['epoch'] = 2
        self.assertEqual(run(self.event, self.store)['status'], 'saved')
        self.event['epoch'] = 1
        self.event['cursor'] = 4
        self.event['expected_generation'] = 2
        self.assertEqual(run(self.event, self.store)['reason'], 'old_replay')

    def test_isolation_and_immutable_ownership(self):
        saved = run(self.event, self.store)
        for key in ['provider_instance', 'environment', 'native_session_id']:
            event = copy.deepcopy(self.event)
            event['binding'][key] += '-other'
            if key == 'native_session_id':
                event['payload']['threadId'] += '-other'
            self.assertEqual(run(event, self.store)['receipt']['generation'], 1)
        for key in ['task_id', 'parent_destination', 'role', 'thread_id', 'card', 'worktree', 'repository_revision', 'lease_refs']:
            event = copy.deepcopy(self.event)
            event['binding'][key] = ['other'] if key == 'lease_refs' else 'reviewer' if key == 'role' else 'other'
            self.assertEqual(run(event, self.store)['reason'], 'ownership_changed')
            self.assertEqual(run({'binding': event['binding']}, self.store, '--recover')['reason'], 'ownership_changed')
        self.assertEqual(run(self.event, self.store)['receipt'], saved['receipt'])

    def test_concurrent_duplicates_converge(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: run(self.event, self.store), range(16)))
        self.assertTrue(any(r['status'] == 'saved' for r in results))
        for result in results:
            self.assertIn(result['status'], ['saved', 'degraded'])
            if result['status'] == 'saved':
                self.assertEqual(result['receipt']['generation'], 1)
            else:
                self.assertEqual(result['reason'], 'store_busy')
        self.assertEqual(run(self.event, self.store)['receipt']['generation'], 1)

    def test_retention_and_evicted_replay(self):
        for i in range(1, 15):
            self.event.update(cursor=i, epoch=i, expected_generation=i-1)
            self.assertEqual(run(self.event, self.store)['status'], 'saved')
        record = json.loads(next(Path(self.store).glob('*/checkpoint.json')).read_text())
        self.assertEqual(len(record['recent_events']), 8)
        self.assertEqual(run(fixture(), self.store)['reason'], 'old_replay')

    def test_storage_failure_malformed_and_size_limits(self):
        bad_store = Path(self.store) / 'file'
        bad_store.write_text('x')
        self.assertEqual(run(self.event, bad_store)['status'], 'degraded')
        for event in [None, [], {}, {**self.event, 'payload': None}, {**self.event, 'payload': {'tokenUsage': []}}, {**self.event, 'checkpoint': {}}, {**self.event, 'checkpoint': {'next_action': 'x' * 70000}}]:
            self.assertIn(run(event, self.store)['status'], ['unknown', 'degraded'])
        event = copy.deepcopy(self.event)
        event['binding']['role'] = 'unrecognized'
        self.assertEqual(run(event, self.store)['status'], 'degraded')

    def test_actual_process_crash_boundaries(self):
        for stage in ['before_replace', 'after_replace', 'after_readback', 'after_receipt']:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as store:
                code = """import json, os, sys
from lib.session_continuity import process, Store
event=json.load(sys.stdin)
def crash(stage):
    if stage == sys.argv[2]: os._exit(71)
process(event, Store(sys.argv[1]), crash)
"""
                p = subprocess.run([sys.executable, '-c', code, store, stage], cwd=ROOT, input=json.dumps(self.event), text=True)
                self.assertEqual(p.returncode, 71)
                saved = run(self.event, store)
                self.assertEqual(saved['status'], 'saved')
                self.assertEqual(saved['receipt']['generation'], 1)
                self.assertEqual(run({'binding': self.event['binding']}, store, '--recover')['checkpoint'], self.event['checkpoint'])

    def test_corruption_and_symlinks_never_claim_saved(self):
        run(self.event, self.store)
        record = next(Path(self.store).glob('*/checkpoint.json'))
        record.write_text('{}')
        self.assertEqual(run(self.event, self.store)['status'], 'degraded')
        record.unlink()
        outside = Path(self.store) / 'outside'
        outside.write_text('untouched')
        record.symlink_to(outside)
        self.assertEqual(run(self.event, self.store)['status'], 'degraded')
        self.assertEqual(outside.read_text(), 'untouched')

    def test_new_model_uses_current_smaller_capacity(self):
        self.event.update(model_fingerprint='smaller', usage_model_fingerprint='smaller')
        self.assertEqual(self.usage(208400, 258400)['decision']['threshold'], 208400)

    def test_cas_concurrent_distinct_writers_preserve_winner(self):
        from concurrent.futures import ThreadPoolExecutor
        events = []
        for i in range(8):
            event = copy.deepcopy(self.event)
            event['cursor'] = i + 1
            event['checkpoint']['next_action'] = str(i)
            events.append(event)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda e: run(e, self.store), events))
        self.assertEqual(sum(r['status'] == 'saved' for r in results), 1)
        winner = next(r for r in results if r['status'] == 'saved')
        recovery = run({'binding': self.event['binding']}, self.store, '--recover')
        self.assertEqual(recovery['checkpoint'], winner['checkpoint'])
        self.assertEqual(recovery['receipt']['generation'], 1)

    def test_per_session_lock_does_not_block_other_sessions(self):
        import fcntl
        from lib.session_continuity import Store
        directory = Store(self.store).directory(self.event['binding'])
        with (directory / 'lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertEqual(run(self.event, self.store)['reason'], 'store_busy')
            event = copy.deepcopy(self.event)
            event['binding']['native_session_id'] = 'other'
            event['payload']['threadId'] = 'other'
            self.assertEqual(run(event, self.store)['status'], 'saved')

    def test_checkpoint_bounds_and_fsync_failure(self):
        from unittest.mock import patch
        from lib.session_continuity import Store, process
        with patch('lib.session_continuity.os.fsync', side_effect=OSError('synthetic disk failure')):
            with self.assertRaises(OSError):
                process(self.event, Store(self.store))
        self.assertFalse(list(Path(self.store).glob('*/checkpoint.json')))
        self.event['checkpoint']['next_action'] = 'x' * 33000
        self.assertEqual(run(self.event, self.store)['status'], 'degraded')

    def test_receipt_digests_match_real_checkpoint_and_binding(self):
        from lib.session_continuity import digest
        result = run(self.event, self.store)
        self.assertEqual(result['receipt']['checkpoint_digest'], digest(self.event['checkpoint']))
        self.assertEqual(result['receipt']['binding_digest'], digest(self.event['binding']))


if __name__ == '__main__':
    unittest.main()
