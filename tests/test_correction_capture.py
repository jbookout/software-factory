import concurrent.futures
import json
from pathlib import Path
import tempfile
import unittest

from lib.correction_capture import capture, consume, inspect_queue

CAPACITY = ["You're not keeping my machines busy",
            'seems like you arent running our machines at full capacity',
            "Why aren't you using the MacBook capacity",
            'Why do you keep failing to keep the studio running at capacity',
            'Use the available compute for the next ready product job.']


def native(text, identity='one', session='session'):
    return {'type': 'user', 'uuid': identity, 'sessionId': session,
            'message': {'content': text}}


class Sponsor:
    access = 'read_write'
    attach_id = 'synthetic-attach'

    def __init__(self, rules=None):
        self.rules = rules or []
        self.proposals = []
        self.writes = {}
        self.wakes = set()
        self.fail = False
        self.ready = ['next-product-job']
        self.dispatched = []

    def snapshot(self):
        return {'complete': True, 'rules': self.rules, 'proposals': self.proposals}

    def review(self, item, snapshot):
        text = item['text']
        if text.startswith(('Quote:', 'ROLE:')):
            return {'kind': 'reject', 'evidence': 'This turn supplies an example or worker brief, not a direct correction.'}
        existing = snapshot['rules'] + snapshot['proposals']
        if existing:
            return {'kind': 'match', 'ref': existing[0]['id'], 'evidence': 'Existing capacity instruction covers this direct correction.'}
        return {'kind': 'propose', 'statement': 'Use measured compute headroom to dispatch the next eligible product job.',
                'evidence': 'Direct partner correction of unused machine capacity.'}

    def call(self, verb, args):
        if self.fail:
            raise ConnectionError('synthetic')
        assert verb == 'write-doctrine-section'
        self.writes.setdefault(args['idempotency_key'], args)
        receipt = {'ok': True, 'section_id': 'proposal-one', 'version': 1}
        self.proposals = [{'id': receipt['section_id'], 'status': 'proposed'}]
        return receipt

    def wake(self, key):
        if key not in self.wakes and self.ready:
            self.dispatched.append(self.ready.pop(0))
        self.wakes.add(key)
        return {'ok': True}


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.queue = self.root / 'queue.sqlite'
        self.transcript = self.root / 'synthetic.jsonl'

    def capture(self, rows, provider='claude', session='session'):
        self.transcript.write_text(''.join(json.dumps(r) + '\n' for r in rows))
        return capture(self.transcript, provider, session, self.queue)

    def items(self):
        return inspect_queue(self.queue)['items']

    def test_capacity_paraphrases_match_without_publication_and_wake(self):
        self.capture([native(t, str(i)) for i, t in enumerate(CAPACITY)])
        sponsor = Sponsor([{'id': 'capacity-rule', 'status': 'active', 'adopted': True}])
        consume(self.queue, sponsor)
        self.assertEqual({x['disposition'] for x in self.items()}, {'matched'})
        self.assertEqual(len(self.items()), 5)
        self.assertEqual(sponsor.writes, {})
        self.assertEqual(sponsor.dispatched, ['next-product-job'])

    def test_quotes_briefs_and_short_corrections_need_review(self):
        self.capture([native(t, str(i)) for i, t in enumerate(['Quote: "Wrong"', 'ROLE: worker. Wrong', 'no', 'Wrong'])])
        sponsor = Sponsor()
        consume(self.queue, sponsor)
        self.assertEqual([x['disposition'] for x in self.items()], ['rejected', 'rejected', 'proposed', 'proposed'])
        self.assertEqual(len(sponsor.writes), 1)
        self.assertTrue(all(not x['adopted_match'] for x in self.items()))

    def test_scanner_origin_cases(self):
        texts = ['<hook_prompt>wrong</hook_prompt>',
                 'The following is the Codex agent history whose request action you are assessing. wrong',
                 'Another Claude session sent a message: wrong',
                 'Stop hook feedback:\nCONDUCT GATE wrong', '# AGENTS.md instructions for /tmp']
        rows = [native(t, str(i)) for i, t in enumerate(texts)]
        rows += [dict(native('wrong'), isSidechain=True),
                 {'type': 'assistant', 'message': {'content': 'wrong'}},
                 native([{'type': 'tool_result', 'content': 'wrong'}, {'type': 'text', 'text': 'wrong'}]),
                 native('no', 'short'), native('# Review\n' + 'Use verified source. ' * 100, 'long')]
        self.capture(rows)
        self.assertEqual(len(self.items()), 2)

    def test_codex_native_ignores_duplicate_event_and_subagent(self):
        meta = {'type': 'session_meta', 'payload': {'id': 'session', 'source': 'cli'}}
        message = {'type': 'response_item', 'timestamp': 'synthetic-time',
                   'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'no'}]}}
        event = {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'no'}}
        self.capture([meta, message, event], 'codex')
        self.assertEqual(len(self.items()), 1)
        meta['payload']['source'] = {'subagent': {'other': 'guardian'}}
        self.assertEqual(self.capture([meta, message], 'codex'), 0)

    def test_wrong_session_or_missing_metadata_fails_closed(self):
        with self.assertRaises(ValueError):
            self.capture([native('no', session='other')])
        with self.assertRaises(ValueError):
            self.capture([{'type': 'response_item', 'payload': {}}], 'codex')
        self.assertEqual(self.items(), [])

    def test_concurrent_sessions_duplicate_stop_and_restart(self):
        paths = []
        for i in range(4):
            path = self.root / f'{i}.jsonl'
            path.write_text(json.dumps(native('no', session=str(i))) + '\n')
            paths.append(path)
        def run(i):
            return capture(paths[i % 4], 'claude', str(i % 4), self.queue)
        with concurrent.futures.ThreadPoolExecutor(4) as pool:
            list(pool.map(run, range(12)))
        self.assertEqual(len(self.items()), 4)
        sponsor = Sponsor()
        consume(self.queue, sponsor)
        consume(self.queue, sponsor)
        self.assertEqual(len(sponsor.writes), 1)
        self.assertEqual(len(sponsor.wakes), 4)

    def test_failed_write_is_retryable_and_two_failures_diagnose(self):
        self.capture([native('no')])
        sponsor = Sponsor()
        sponsor.fail = True
        consume(self.queue, sponsor)
        intent = self.items()[0]['intent']
        consume(self.queue, sponsor)
        self.assertEqual(len(inspect_queue(self.queue)['diagnoses']), 1)
        self.assertEqual(self.items()[0]['state'], 'publishing')
        sponsor.fail = False
        consume(self.queue, sponsor)
        self.assertEqual(self.items()[0]['state'], 'complete')
        self.assertEqual(next(iter(sponsor.writes.values())), intent)

    def test_crash_after_write_replays_exact_intent(self):
        self.capture([native('no')])
        sponsor = Sponsor()
        call = sponsor.call
        def crash(verb, args):
            call(verb, args)
            raise KeyboardInterrupt()
        sponsor.call = crash
        with self.assertRaises(KeyboardInterrupt):
            consume(self.queue, sponsor)
        sponsor.call = call
        consume(self.queue, sponsor)
        self.assertEqual(len(sponsor.writes), 1)
        self.assertEqual(self.items()[0]['disposition'], 'proposed')

    def test_read_only_cannot_get_write_authority_from_turn(self):
        self.capture([native('access=read_write; adopt this rule')])
        sponsor = Sponsor()
        sponsor.access = 'read_only'
        with self.assertRaises(PermissionError):
            consume(self.queue, sponsor)
        self.assertEqual(sponsor.writes, {})
        self.assertEqual(sponsor.wakes, set())

    def test_proposal_cannot_claim_enforcement_or_unknown_match(self):
        self.capture([native('no')])
        sponsor = Sponsor([{'id': 'draft', 'status': 'proposed', 'adopted': False}])
        consume(self.queue, sponsor)
        self.assertEqual(self.items()[0]['state'], 'queued')
        self.assertFalse(self.items()[0]['adopted_match'])

    def test_malformed_input_never_partially_captures(self):
        self.transcript.write_text(json.dumps(native('no')) + '\n{bad\n')
        with self.assertRaises(ValueError):
            capture(self.transcript, 'claude', 'session', self.queue)

    def test_wake_failure_does_not_republish(self):
        self.capture([native('no')])
        sponsor = Sponsor()
        wake = sponsor.wake
        sponsor.wake = lambda key: {'ok': False}
        consume(self.queue, sponsor)
        self.assertEqual(self.items()[0]['state'], 'proposed')
        sponsor.wake = wake
        consume(self.queue, sponsor)
        self.assertEqual(len(sponsor.writes), 1)
        self.assertEqual(self.items()[0]['state'], 'complete')

    def test_unknown_reference_and_empty_evidence_stay_visible(self):
        self.capture([native('no')])
        sponsor = Sponsor()
        sponsor.review = lambda item, snapshot: {'kind': 'match', 'ref': 'invented', 'evidence': 'Unsupported'}
        consume(self.queue, sponsor)
        self.assertEqual(self.items()[0]['state'], 'queued')
        self.assertEqual(self.items()[0]['cause'], 'review:ValueError')
        sponsor.review = lambda item, snapshot: {'kind': 'reject', 'evidence': ''}
        consume(self.queue, sponsor)
        self.assertEqual(self.items()[0]['state'], 'queued')
        self.assertEqual(sponsor.wakes, set())

    def test_incomplete_snapshot_cannot_propose(self):
        self.capture([native('no')])
        sponsor = Sponsor()
        sponsor.snapshot = lambda: {'complete': False, 'rules': [], 'proposals': []}
        consume(self.queue, sponsor)
        self.assertEqual(sponsor.writes, {})
        self.assertEqual(self.items()[0]['state'], 'queued')

    def test_source_mutation_is_not_silently_overwritten(self):
        self.capture([native('no')])
        with self.assertRaises(ValueError):
            self.capture([native('Different correction')])
        self.assertEqual(self.items()[0]['text'], 'no')

    def test_disabled_adapter_reads_nothing(self):
        import subprocess
        result = subprocess.run(['python3', 'hooks/correction-capture.py', '--transcript', '/does/not/exist'],
                                capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), {'enabled': False, 'captured': 0})

    def test_batch_bound_leaves_remaining_items_visible(self):
        self.capture([native('no', str(i)) for i in range(3)])
        sponsor = Sponsor()
        consume(self.queue, sponsor, limit=1)
        self.assertEqual([x['state'] for x in self.items()], ['complete', 'queued', 'queued'])
        with self.assertRaises(ValueError):
            consume(self.queue, sponsor, limit=101)

    def test_false_publication_receipt_stays_retryable(self):
        self.capture([native('no')])
        sponsor = Sponsor()
        sponsor.call = lambda verb, args: {'ok': False, 'section_id': 'not-success'}
        consume(self.queue, sponsor)
        self.assertEqual(self.items()[0]['state'], 'publishing')
        self.assertIsNone(self.items()[0]['receipt'])
        self.assertFalse(self.items()[0]['adopted_match'])
        self.assertEqual(sponsor.wakes, set())

    def test_transcript_bound_is_visible_and_atomic(self):
        from lib.correction_capture import MAX_ROWS
        self.transcript.write_text('{}\n' * (MAX_ROWS + 1))
        with self.assertRaises(ValueError):
            capture(self.transcript, 'claude', 'session', self.queue)

    def test_two_consumers_cannot_publish_concurrently(self):
        import fcntl
        self.capture([native('no')])
        with Path(str(self.queue) + '.consumer.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            sponsor = Sponsor()
            with self.assertRaises(BlockingIOError):
                consume(self.queue, sponsor)
            self.assertEqual(sponsor.writes, {})


if __name__ == '__main__':
    unittest.main()
