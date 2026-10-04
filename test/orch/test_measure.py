import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('measure', ROOT / 'scripts/orch/measure-runs.py')
measure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(measure)

HEAD = 'a' * 40
def event(kind, attempt='one', second=0, **values):
    return {**dict(schema='orch-event/v1', id=f'{attempt}-{kind}-{second}', repo='example/tool',
                pr=1, head=HEAD, lane='ci', attempt=attempt, kind=kind,
                at=f'2026-10-04T00:{second // 60:02}:{second % 60:02}Z', job='job-one'), **values}


class Measurement(unittest.TestCase):
    def test_historical_rounds_and_separate_bug_denominator(self):
        audit = json.loads((ROOT / 'test/orch/fixtures/failure-rounds.json').read_text())
        bugs = json.loads((ROOT / 'test/orch/fixtures/bug-counts.json').read_text())
        report = measure.historical(audit, bugs)
        self.assertEqual(report['failed_rounds'], 994)
        self.assertEqual(len(report['buckets']), 18)
        self.assertEqual(report['stages'], {'ci': 359, 'review': 294, 'agent': 97, 'queue': 49, 'release': 195})
        self.assertEqual(report['bug_study']['finding_occurrences'], 1124)
        self.assertEqual(report['bug_study']['classes'], 21)
        self.assertEqual(report['bug_study']['blocked_comments'], 296)
        self.assertEqual(report['bug_study']['prs'], 145)
        self.assertEqual(report['candidate_rates']['status'], 'unknown')

    def test_refusal_unknown_red_superseded_then_shipped(self):
        rows = [event('refused', f'refuse-{i}', i, cause='budget') for i in range(9)]
        rows += [event('api_unknown', 'api', 10), event('ci', 'red', 20,
                  required=['strict'], checks=[{'name': 'strict', 'conclusion': 'failure'}]),
                 event('superseded', 'old', 30), event('merged', 'merge', 40)]
        receipt = {'repo': 'example/tool', 'pr': 1, 'head': HEAD, 'live_sha': HEAD, 'status': 'verified'}
        with tempfile.TemporaryDirectory() as directory:
            artifact = measure.save_immutable(Path(directory) / 'release.json', receipt)
            rows += [event('delivered', 'release', 100, artifact=artifact)]
            report = measure.measure(rows, artifact_root=directory)
        self.assertEqual(report['rounds'], {'refused': 9, 'unknown': 1, 'failed': 1, 'superseded': 1})
        self.assertEqual(report['candidate_rates']['eligible'], 1)
        self.assertEqual(report['candidate_rates']['first_ci_failed_fraction'], 1)
        self.assertEqual(report['started_executions'], 0)
        self.assertIsNone(report['usage']['tokens']['total'])
        self.assertEqual(report['timings']['live_lag_seconds']['median'], 60)
        self.assertEqual(report['candidates'][0]['delivery'], 'verified')

    def test_queue_setup_compute_cleanup_and_work_normalization(self):
        rows = [event('offered'), event('enqueued', second=1),
                event('dependency_ready', second=361), event('started', second=481),
                event('setup_finished', second=491), event('tests', second=500, tests_run=10, tests_passed=10),
                event('usage', second=501, tokens=20, dollars=0.01),
                event('completed', second=541, outcome='passed'), event('cleanup', second=551),
                event('job_terminal', second=552)]
        report = measure.measure(rows)
        for metric, seconds in [('waiting_seconds', 480), ('dependency_wait_seconds', 360),
                                ('resource_wait_seconds', 120), ('compute_seconds', 60),
                                ('setup_seconds', 10), ('cleanup_seconds', 10)]:
            self.assertEqual(report['timings'][metric]['p95'], seconds)
        self.assertEqual(report['work']['total_compute_seconds'], 60)
        self.assertEqual(report['work']['compute_seconds_per_test'], 6)
        self.assertEqual(report['usage']['tokens']['total'], 20)
        self.assertEqual(report['conservation'], {'offered': 1, 'pending': 0, 'owned': 0, 'terminal': 1, 'unoffered': 0})

    def test_no_first_ci_denominator_from_partial_cancelled_or_missing(self):
        for rows in [[], [event('ci', required=['strict'], checks=[])],
                     [event('ci', required=['strict'], checks=[{'name': 'strict', 'conclusion': 'cancelled'}])],
                     [event('completed', outcome='passed')]]:
            report = measure.measure(rows)
            self.assertEqual(report['candidate_rates']['status'], 'unknown')
            self.assertIsNone(report['candidate_rates']['first_ci_failed_fraction'])

    def test_conflicting_replay_and_source_substitution_rejected(self):
        original = event('started')
        self.assertEqual(measure.measure([original, original])['started_executions'], 1)
        changed = {**original, 'head': 'b' * 40}
        with self.assertRaises(ValueError):
            measure.measure([original, changed])
        with self.assertRaises(ValueError):
            measure.measure([original, event('completed', second=1, head_override='unused', outcome='passed', head='b' * 40)])

    def test_overlapping_attempts_sum_work_not_elapsed(self):
        rows = [event('started', 'a', 0), event('started', 'b', 0),
                event('completed', 'a', 60, outcome='failed'), event('completed', 'b', 60, outcome='passed')]
        self.assertEqual(measure.measure(rows)['work']['total_compute_seconds'], 120)

    def test_owned_response_dedup_unknown_clear_reopen(self):
        policy = dict(id='slow-ci', metric='timings.compute_seconds.p95', max=50, min_samples=1,
                      owner='ci-maintainer', remediation='Profile the slowest class',
                      test='Replay the fixed workload', clear='Two complete windows below 50', clear_windows=2)
        report = measure.measure([event('started'), event('completed', second=60, outcome='passed')])
        first = measure.respond(report, [policy], {}, 'window-one')
        second = measure.respond(report, [policy], first, 'window-two')
        self.assertEqual(len(second['responses']), 1)
        self.assertEqual(second['responses']['slow-ci']['status'], 'open')
        unknown = measure.respond(measure.measure([]), [policy], second, 'empty')
        self.assertEqual(unknown['responses']['slow-ci']['status'], 'open')
        clean = measure.measure([event('started'), event('completed', second=40, outcome='passed')])
        cleared = measure.respond(clean, [policy], unknown, 'good-one')
        replay = measure.respond(clean, [policy], cleared, 'good-one')
        self.assertEqual(replay, cleared)
        cleared = measure.respond(clean, [policy], cleared, 'good-two')
        self.assertEqual(cleared['responses']['slow-ci']['status'], 'cleared')
        self.assertEqual(measure.respond(report, [policy], cleared, 'bad-again')['responses']['slow-ci']['status'], 'open')
        with self.assertRaises(ValueError):
            measure.respond(report, [{**policy, 'owner': ''}], {}, 'bad')

    def test_unknown_sample_never_clears_and_unmatched_legacy_is_disclosed(self):
        report = measure.measure([{'repo': 'example/tool', 'pr': 1, 'at': '2026-10-04T00:00:00Z',
                                   'step': 'fix', 'status': 'complete', 'message': 'SECRET-CANARY'}])
        self.assertEqual(report['unjoinable_records'], 1)
        self.assertEqual(report['candidate_rates']['status'], 'unknown')
        self.assertNotIn('SECRET-CANARY', json.dumps(report))

    def test_delivery_digest_identity_retention_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.json'
            artifact = measure.save_immutable(path, {'repo': 'example/tool', 'pr': 1, 'head': HEAD,
                                                       'live_sha': 'b' * 40, 'status': 'verified'})
            report = measure.measure([event('delivered', artifact=artifact)], artifact_root=directory)
            self.assertEqual(report['candidates'][0]['delivery'], 'unknown')
            with self.assertRaises(FileExistsError):
                measure.save_immutable(path, {'new': True})
            path.write_text('{}')
            report = measure.measure([event('delivered', artifact=artifact)], artifact_root=directory)
            self.assertEqual(report['candidates'][0]['delivery'], 'unknown')

    def test_log_artifact_bytes_retained_across_attempts(self):
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'one.log'
            data = b'SECRET-CANARY diagnostic bytes'
            path.write_bytes(data)
            artifact = {'ref': path.name, 'digest': hashlib.sha256(data).hexdigest()}
            rows = [event('completed', 'a', outcome='failed', diagnostic=artifact),
                    event('completed', 'b', outcome='passed', diagnostic=artifact)]
            report = measure.measure(rows, artifact_root=directory)
            self.assertEqual(len(report['diagnostics']), 2)
            self.assertTrue(all(a['status'] == 'verified' for a in report['diagnostics']))
            self.assertNotIn('SECRET-CANARY', json.dumps(report))
            self.assertEqual(path.read_bytes(), data)

    def test_existing_build_measurement_receipt_bound_to_event(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = {'status': 'pass', 'measurements': {'testsRun': 10, 'testsPassed': 10, 'durationMs': 25},
                       'data': {'candidateRevision': HEAD}}
            artifact = measure.save_immutable(Path(directory) / 'build.json', receipt)
            report = measure.measure([event('performance', artifact=artifact)], artifact_root=directory)
            self.assertEqual(report['performance_receipts'][0]['testsRun'], 10)
            self.assertIsNone(report['work']['total_compute_seconds'])
            receipt['data']['candidateRevision'] = 'b' * 40
            wrong = measure.save_immutable(Path(directory) / 'wrong.json', receipt)
            report = measure.measure([event('performance', artifact=wrong)], artifact_root=directory)
            self.assertEqual(report['performance_receipts'][0]['status'], 'unknown')

    def test_partial_usage_retains_unknown_total(self):
        report = measure.measure([event('started'), event('usage', second=1, tokens=5)])
        self.assertEqual(report['usage']['tokens']['total'], 5)
        self.assertIsNone(report['usage']['dollars']['total'])
        report = measure.measure([event('started', 'a'), event('usage', 'a', 1, tokens=5), event('started', 'b')])
        self.assertIsNone(report['usage']['tokens']['total'])
        self.assertEqual(report['usage']['tokens']['observed'], 5)

    def test_unknown_ci_snapshot_can_be_completed_without_new_round(self):
        rows = [event('ci', second=1, required=['strict'], checks=[]),
                event('ci', second=2, required=['strict'], checks=[{'name': 'strict', 'conclusion': 'success'}])]
        report = measure.measure(rows)
        self.assertEqual(report['ci_rounds'], 1)
        self.assertEqual(report['candidate_rates']['first_ci_failed_fraction'], 0)
        with self.assertRaises(ValueError):
            measure.measure([event('ci', second=1, required=['strict'], checks=[{'name': 'strict', 'conclusion': 'failure'}]), rows[1]])

    def test_retries_conserve_one_logical_job_and_reopen(self):
        rows = [event('offered'), event('refused', 'a', 1), event('offered', 'b', 2),
                event('started', 'b', 3), event('completed', 'b', 4, outcome='passed'),
                event('job_terminal', 'b', 5)]
        report = measure.measure(rows)
        self.assertEqual(report['conservation']['offered'], 1)
        self.assertEqual(report['conservation']['terminal'], 1)
        reopened = measure.measure(rows + [event('job_reopened', 'c', 6)])
        self.assertEqual(reopened['conservation']['pending'], 1)
        duplicate = measure.measure([event('offered'), event('started', 'a', 1), event('started', 'b', 2)])
        self.assertEqual(len(duplicate['job_responses']), 1)
        orphan = measure.measure([event('started')])
        self.assertEqual(orphan['conservation']['unoffered'], 1)

    def test_strata_do_not_average_interventions_into_baseline(self):
        report = measure.measure([event('started', 'a', intervention='cache-rollout'),
                                  event('completed', 'a', 10, outcome='passed', intervention='cache-rollout'),
                                  event('started', 'b'), event('completed', 'b', 60, outcome='passed')])
        self.assertEqual(len(report['strata']), 2)
        self.assertEqual({s['measurement']['work']['total_compute_seconds'] for s in report['strata']}, {10, 60})

    def test_delivery_rejects_each_binding_substitution_independently(self):
        valid = {'repo': 'example/tool', 'pr': 1, 'head': HEAD, 'live_sha': HEAD, 'status': 'verified'}
        with tempfile.TemporaryDirectory() as directory:
            for field, wrong in [('repo', 'example/other'), ('pr', 2), ('head', 'b' * 40),
                                 ('live_sha', 'b' * 40), ('status', 'claimed')]:
                with self.subTest(field=field):
                    artifact = measure.save_immutable(Path(directory) / f'{field}.json', {**valid, field: wrong})
                    report = measure.measure([event('delivered', artifact=artifact)], artifact_root=directory)
                    self.assertEqual(report['verified_deliveries'], 0)
            artifact = measure.save_immutable(Path(directory) / 'valid.json', valid)
            self.assertEqual(measure.measure([event('delivered', artifact=artifact)], artifact_root=directory)['verified_deliveries'], 1)

    def test_empty_partial_exception_and_missing_ack_cli_matrix(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'input.jsonl'
            for content, code in [('', 0), ('{}\n', 0), ('{"partial":', 2),
                                  (json.dumps(event('delivered')) + '\n', 0)]:
                path.write_text(content)
                result = subprocess.run([sys.executable, str(ROOT / 'scripts/orch/measure-runs.py'),
                                         '--events', str(path)], capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, code)
                report = json.loads(result.stdout)
                self.assertEqual(report.get('candidate_rates', {}).get('status', 'unknown'), 'unknown')
                self.assertEqual(result.stderr, '')
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/orch/measure-runs.py'),
                                     '--events', str(Path(directory) / 'SECRET-CANARY')], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 2)
            self.assertNotIn('SECRET-CANARY', result.stdout + result.stderr)

    def test_timezone_strata_and_incomplete_comparison(self):
        rows = [event('started', at='2026-10-03T20:00:00-05:00'),
                event('completed', at='2026-10-04T01:01:00Z', outcome='passed')]
        report = measure.measure(rows)
        self.assertEqual(report['strata'][0]['utc_day'], '2026-10-04')
        comparison = measure.compare(measure.measure([]), report)
        self.assertEqual(comparison['status'], 'unknown')
        self.assertIsNone(comparison['metrics']['total_compute_seconds']['delta'])

    def test_log_symlink_fifo_and_canary_digest_refuse(self):
        import os
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'target').write_text('sensitive')
            (root / 'link').symlink_to(root / 'target')
            os.mkfifo(root / 'pipe')
            for ref in ['link', 'pipe', '../target', '/target']:
                self.assertIsNone(measure.read_artifact_bytes(root, {'ref': ref, 'digest': 'a' * 64}))
            with self.assertRaises(ValueError):
                measure.measure([event('completed', outcome='failed', diagnostic={'digest': 'SECRET-CANARY'})])

    def test_first_pr_failure_does_not_count_same_pr_twice(self):
        rows = [event('ci', 'red', 1, required=['strict'], checks=[{'name': 'strict', 'conclusion': 'failure'}]),
                event('ci', 'green', 2, head='b' * 40, required=['strict'], checks=[{'name': 'strict', 'conclusion': 'success'}])]
        report = measure.measure(rows)
        self.assertEqual(report['pr_rates']['eligible'], 1)
        self.assertEqual(report['pr_rates']['first_required_ci_failed_fraction'], 1)
        self.assertEqual(report['candidate_rates']['eligible'], 2)


if __name__ == '__main__':
    unittest.main()
