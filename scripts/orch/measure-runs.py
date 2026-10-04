#!/usr/bin/env python3
"""Offline lifecycle measurement. Reads evidence; never dispatches or changes product state."""
import argparse
import base64
from collections import Counter, defaultdict
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import statistics
import sys
import tempfile
import zlib

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
BUILD_VALIDATOR = Draft202012Validator(json.loads((ROOT / 'schemas/factory-build-result.schema.json').read_text()))
_reader_spec = importlib.util.spec_from_file_location('artifact_reader', ROOT / 'src/read-artifact.py')
_reader = importlib.util.module_from_spec(_reader_spec)
_reader_spec.loader.exec_module(_reader)
MAX_BYTES = 10 * 1024 * 1024

KINDS = {'offered', 'enqueued', 'dependency_ready', 'admitted', 'started', 'setup_finished',
         'tests', 'usage', 'completed', 'cleanup', 'ci', 'api_unknown', 'refused',
         'superseded', 'merged', 'delivered', 'cancelled', 'performance', 'job_terminal', 'job_reopened'}
IDENTIFIER = re.compile(r'^[A-Za-z0-9_.:/-]{1,160}$')
SHA = re.compile(r'^[0-9a-f]{40}$')
METRICS = ('waiting_seconds', 'dependency_wait_seconds', 'resource_wait_seconds',
           'setup_seconds', 'compute_seconds', 'cleanup_seconds', 'live_lag_seconds')
BUCKETS = {
    'Correctness defect caught by review', 'Local-verifiable check failure; local execution unproven',
    'Cancelled CI reports red through aggregate check', 'Agent budget refusals / execution timeouts',
    'Persistent release precondition / staging-ledger failure',
    'Fix leaves prior blocker unresolved / cross-repo dependency', 'Migration / registry / contract integration drift',
    'Release readiness rejections retried without changed evidence', 'Merge conflict / branch update failure',
    'Repeated blocked review on unchanged head', 'CI / browser timeout or intermittent test',
    'Missing or invalid delivery / eval evidence', 'Release browser failure / timeout (cause mixed)',
    'GitHub / network / CI environment failure', 'Orchestrator routing / readback / retry defect',
    'Release execution / live verification failure', 'Review invalidated by main merge / head movement',
    'Release worktree / shared-ref recovery defect',
}


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamp needs a timezone')
    return parsed.timestamp()


def number(value):
    try:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def distribution(values, expected):
    """Nearest-rank p95; absent/censored samples remain visible, never zero-filled."""
    ordered = sorted(values)
    return {'samples': len(values), 'missing': expected - len(values),
            'status': 'complete' if expected and len(values) == expected else 'unknown',
            'median': statistics.median(values) if values else None,
            'p95': ordered[math.ceil(.95 * len(ordered)) - 1] if ordered else None}


def save_immutable(path, value):
    """Publish complete bytes without replacing any prior head/attempt report."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(value, sort_keys=True, allow_nan=False) + '\n').encode()
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.measurement-')
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)  # atomic and exclusive; an old report survives failure
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(temporary)
    return {'ref': path.name, 'digest': hashlib.sha256(data).hexdigest()}


def read_artifact_bytes(root, artifact):
    """Reuse the evidence store's bounded, component-level no-follow reader."""
    if not root or not isinstance(artifact, dict):
        return None
    ref = artifact.get('ref')
    if not isinstance(ref, str):
        return None
    try:
        root = os.path.abspath(root)  # Do not resolve symlinks; the shared reader refuses them.
        identity = os.stat(root)
        encoded = _reader.read_artifact({'root': root, 'device': identity.st_dev, 'inode': identity.st_ino,
                                         'ref': ref, 'max_bytes': MAX_BYTES})
        if encoded is None:
            return None
        data = base64.b64decode(encoded, validate=True)
        if hashlib.sha256(data).hexdigest() != artifact.get('digest'):
            return None
        return data
    except (OSError, ValueError):
        return None


def read_artifact(root, artifact):
    data = read_artifact_bytes(root, artifact)
    try:
        result = json.loads(data) if data is not None else None
        return result if isinstance(result, dict) else None
    except (ValueError, RecursionError):
        return None


def historical(audit, bugs=None):
    """Reproduce classified rounds, without converting their selective sample into a rate."""
    events = audit['events']
    identities = set()
    for index, row in enumerate(events):
        stage = row['stage']
        if stage not in ('ci', 'review', 'agent', 'queue', 'release') or row['bucket'] not in BUCKETS:
            raise ValueError('invalid historical classification')
        identity = (row['repo'], stage, row['run'], row['attempt']) if stage == 'ci' else (
            (row['repo'], stage, row['id']) if stage == 'review' else
            (row['repo'], stage, row['ts'], row.get('pr'), row.get('sha')))
        if identity in identities:
            raise ValueError('duplicate historical round')
        identities.add(identity)
    result = {'failed_rounds': len(events), 'buckets': dict(Counter(r['bucket'] for r in events)),
              'stages': dict(Counter(r['stage'] for r in events)),
              'window': {'start': audit['start'], 'cutoff': audit['cutoff']},
              'candidate_rates': {'status': 'unknown', 'reason': 'classified failures are not the eligible candidate denominator'},
              'semantic_classification': 'retained audit judgments, not independently reproduced defects'}
    if bugs:
        if not all(type(n) is int and n >= 0 for n in bugs['findings_by_class']):
            raise ValueError('invalid bug counts')
        result['bug_study'] = {'finding_occurrences': sum(bugs['findings_by_class']),
                               'classes': len(bugs['findings_by_class']), 'blocked_comments': bugs['blocked_comments'],
                               'prs': bugs['prs'], 'cutoff': bugs['cutoff'],
                               'unit': 'reported finding occurrences, not failed rounds or unique defects'}
    return result


def decode_audit(path):
    with Path(path).open('rb') as source:
        data = source.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('audit too large')
    text = data.decode()
    payload = text.rsplit('<!-- FAILURE_AUDIT_EVIDENCE_START -->', 1)[1].split('```text\n')[1].split('\n```')[0]
    decoder = zlib.decompressobj()
    decoded = decoder.decompress(base64.b64decode(payload, validate=True), MAX_BYTES + 1)
    if len(decoded) > MAX_BYTES or not decoder.eof or decoder.unused_data:
        raise ValueError('invalid or oversized compressed audit')
    return json.loads(decoded)


def read_bug_counts(path):
    path = Path(path)
    if path.suffix == '.json':
        return json.loads(path.read_text())
    text = path.read_text()
    block = text.split('## Ranked bug classes', 1)[1].split('\n## ', 1)[0]
    counts = [int(m[1]) for m in re.findall(r'^\| (\d+) \| [^|]+ \| (\d+) \|', block, re.M)]
    comments, prs = re.search(r'([\d,]+) REVIEW: BLOCKED comments across ([\d,]+) PRs', text).groups()
    cutoff = re.search(r'Final read cutoff: \*\*([^*]+)\*\*', text).group(1)
    return {'blocked_comments': int(comments.replace(',', '')), 'prs': int(prs.replace(',', '')),
            'findings_by_class': counts, 'cutoff': cutoff}


def measure(records, artifact_root=None, stratify=True, window=None):
    """Join only bound normalized events. Legacy delivery lines are disclosed as unjoinable."""
    if window is not None and stratify:
        # Validate the journal before censoring; outside-window contradictions stay invalid.
        records = list(records)
        measure(records, artifact_root, stratify=False)
    attempts = defaultdict(list)
    seen = {}
    unjoinable = 0
    for row in records:
        if not isinstance(row, dict) or row.get('schema') != 'orch-event/v1':
            unjoinable += 1
            continue
        for key in ('id', 'repo', 'lane', 'attempt'):
            if not isinstance(row.get(key), str) or not IDENTIFIER.fullmatch(row[key]):
                raise ValueError('invalid event identifier')
        if row.get('job') is not None and (not isinstance(row['job'], str) or not IDENTIFIER.fullmatch(row['job'])):
            raise ValueError('invalid job identifier')
        if row.get('kind') not in KINDS or not SHA.fullmatch(row.get('head', '')) or (
                type(row.get('pr')) is not int or row['pr'] <= 0):
            raise ValueError('invalid event binding')
        for field in ('base', 'tree'):
            if row.get(field) is not None and not SHA.fullmatch(row[field]):
                raise ValueError('invalid source binding')
        timestamp(row['at'])
        key = (row['repo'], row['id'])
        if key in seen:
            if seen[key] != row:
                raise ValueError('conflicting event replay')
            continue
        seen[key] = row
        attempts[(row['repo'], row['pr'], row['lane'], row['attempt'])].append(row)

    timings = {name: [] for name in METRICS}
    timing_expected = Counter()
    rounds = Counter()
    candidates = defaultdict(lambda: {'ci': [], 'merged': [], 'delivered': []})
    normalized_attempts = []
    totals = {'tokens': [], 'dollars': []}
    usage_complete = {'tokens': set(), 'dollars': set()}
    executions = set()
    complete_tests = set()
    work = []
    tests = []
    performance = []
    artifacts = []
    started_count = 0
    censored_count = 0
    job_rows = defaultdict(list)
    unbound_jobs = 0
    for identity, rows in sorted(attempts.items()):
        rows.sort(key=lambda r: (timestamp(r['at']), r['id']))
        visible = rows if window is None else [r for r in rows if window[0] <= timestamp(r['at']) <= window[1]]
        start_row = next((r for r in rows if r['kind'] == 'started'), None)
        end_row = next((r for r in rows if r['kind'] in ('completed', 'cancelled', 'superseded')), None)
        spans_window = window is not None and start_row is not None and timestamp(start_row['at']) <= window[1] and (
            end_row is None or timestamp(end_row['at']) >= window[0])
        if not visible and not spans_window:
            continue
        censored = window is not None and len(visible) != len(rows)
        # Pre-window phases are context; future phases cannot settle current ownership/outcome.
        rows = rows if window is None else [r for r in rows if timestamp(r['at']) <= window[1]]
        heads = {r['head'] for r in rows}
        if len(heads) != 1 or any(len({r[f] for r in rows if r.get(f)}) > 1 for f in ('base', 'tree')):
            raise ValueError('attempt crossed source bindings')
        repo, pr, lane, attempt = identity
        head = rows[0]['head']
        candidate = candidates[(repo, pr, head)]
        by_kind = defaultdict(list)
        for row in rows:
            by_kind[row['kind']].append(row)
            if row.get('job'):
                job_rows[(repo, row['job'])].append(row)
        if not any(r.get('job') for r in rows):
            unbound_jobs += 1
        if len({r['job'] for r in rows if r.get('job')}) > 1:
            raise ValueError('attempt crossed job identities')
        # Multiple observations of CI are legitimate; multiple lifecycle starts/ends are not.
        for kind in KINDS - {'ci', 'api_unknown', 'usage', 'tests', 'job_terminal', 'job_reopened'}:
            if len(by_kind[kind]) > 1:
                raise ValueError('duplicate lifecycle phase in an attempt')
        times = {k: timestamp(v[0]['at']) for k, v in by_kind.items() if v}
        started = 'started' in times
        terminals = [k for k in ('completed', 'refused', 'cancelled', 'superseded') if by_kind[k]]
        if len(terminals) > 1:
            raise ValueError('contradictory terminal phases')
        if started and any(times[k] < times['started'] for k in ('completed', 'cancelled', 'superseded') if k in times):
            raise ValueError('terminal phase predates execution')
        if by_kind['refused'] and (started or by_kind['usage'] or by_kind['tests'] or by_kind['performance'] or by_kind['setup_finished'] or by_kind['cleanup']):
            raise ValueError('refused attempt cannot have execution evidence')
        execution = any(by_kind[k] for k in ('started', 'setup_finished', 'completed', 'cleanup', 'usage', 'tests', 'performance'))
        if execution:
            executions.add(identity)
            censored_count += int(censored)
        started_count += int(started and (window is None or window[0] <= times['started'] <= window[1]))
        duration = {}
        for name, first, last in [('waiting_seconds', 'enqueued', 'started'),
                                  ('dependency_wait_seconds', 'enqueued', 'dependency_ready'),
                                  ('resource_wait_seconds', 'dependency_ready', 'started'),
                                  ('setup_seconds', 'started', 'setup_finished'),
                                  ('compute_seconds', 'started', 'completed'),
                                  ('cleanup_seconds', 'completed', 'cleanup')]:
            if first in times or last in times:
                timing_expected[name] += 1
            if first in times and last in times:
                delta = times[last] - times[first]
                if delta < 0:
                    raise ValueError('inverted phase timestamps')
                if not censored:
                    duration[name] = delta
                    timings[name].append(delta)
        if execution and 'started' not in times and 'completed' not in times:
            timing_expected['compute_seconds'] += 1
        outcome = by_kind['completed'][0].get('outcome') if by_kind['completed'] else None
        if outcome is not None and outcome not in ('passed', 'failed', 'unknown', 'timeout'):
            raise ValueError('invalid terminal outcome')
        if outcome in ('failed', 'timeout'):
            rounds['failed'] += 1
        if by_kind['refused']:
            rounds['refused'] += 1
        if by_kind['api_unknown'] or outcome == 'unknown':
            rounds['unknown'] += 1
        if by_kind['superseded'] or by_kind['cancelled']:
            rounds['superseded'] += 1
        ci_verdicts = []
        required_contract = None
        for ci in by_kind['ci']:
            required, checks = ci.get('required'), ci.get('checks')
            contract = sorted(required) if isinstance(required, list) and all(isinstance(n, str) for n in required) else None
            if ci_verdicts and contract != required_contract:
                raise ValueError('CI attempt changed required-context contract')
            required_contract = contract
            verdict = 'unknown'
            if isinstance(required, list) and required and all(isinstance(n, str) for n in required) and isinstance(checks, list):
                mapping = {c.get('name'): c.get('conclusion') for c in checks if isinstance(c, dict)}
                if len(mapping) == len(checks) and len(set(required)) == len(required) and all(
                        mapping.get(n) in ('success', 'failure', 'timed_out', 'action_required') for n in required):
                    verdict = 'failed' if any(mapping[n] != 'success' for n in required) else 'passed'
            ci_verdicts.append(verdict)
        if ci_verdicts:
            terminal = {v for v in ci_verdicts if v != 'unknown'}
            if len(terminal) > 1:
                raise ValueError('CI attempt has conflicting terminal verdicts')
            verdict = next(iter(terminal), 'unknown') if not censored else 'unknown'
            candidate['ci'].append((times.get('started', times.get('enqueued', times['ci'])), lane, attempt, verdict))
        # A failed required CI observation is one round per run/attempt, not per leaf job.
        if ci_verdicts and verdict == 'failed' and outcome not in ('failed', 'timeout'):
            rounds['failed'] += 1
        if by_kind['merged']:
            candidate['merged'].append(times['merged'])
        for row in by_kind['delivered']:
            receipt = read_artifact(artifact_root, row.get('artifact'))
            if receipt and all(receipt.get(k) == v for k, v in
                               {'repo': repo, 'pr': pr, 'head': head, 'live_sha': head, 'status': 'verified'}.items()):
                candidate['delivered'].append(times['delivered'])
        for metric in totals:
            observed = [r.get(metric) for r in by_kind['usage']]
            if any(v is not None and not number(v) for v in observed):
                raise ValueError('invalid usage')
            values = [r[metric] for r in visible if r['kind'] == 'usage' and number(r.get(metric))]
            if values:
                totals[metric].append(sum(values))
            if started and not censored and observed and all(number(v) for v in observed):
                usage_complete[metric].add(identity)
        for row in rows:
            if row.get('diagnostic'):
                if not isinstance(row['diagnostic'], dict) or not re.fullmatch(r'[0-9a-f]{64}', row['diagnostic'].get('digest', '')):
                    raise ValueError('invalid diagnostic digest')
                data = read_artifact_bytes(artifact_root, row['diagnostic'])
                artifacts.append({'repo': repo, 'pr': pr, 'head': head, 'attempt': attempt,
                                  'digest': row['diagnostic'].get('digest'),
                                  'status': 'verified' if data is not None else 'unknown',
                                  'bytes': len(data) if data is not None else None})
        for row in by_kind['performance']:
            receipt = read_artifact(artifact_root, row.get('artifact'))
            inventory = receipt.get('measurements') if receipt else None
            bound = receipt and BUILD_VALIDATOR.is_valid(receipt) and receipt['data']['candidateRevision'] == head
            if bound:
                if inventory.get('testsRun') is not None and inventory.get('testsPassed') is not None and inventory['testsPassed'] > inventory['testsRun']:
                    raise ValueError('invalid performance test inventory')
                performance.append({'repo': repo, 'pr': pr, 'head': head, 'attempt': attempt,
                                    'status': receipt['status'], **{f: inventory.get(f) for f in ('testsRun', 'testsPassed', 'durationMs')}})
            else:
                performance.append({'repo': repo, 'pr': pr, 'head': head, 'attempt': attempt, 'status': 'unknown'})
        observed_tests = by_kind['tests']
        if observed_tests:
            if not started:
                raise ValueError('test aggregate lacks execution start')
            if len(observed_tests) != 1:
                raise ValueError('tests must be a single aggregate per attempt')
            r = observed_tests[0]
            if type(r.get('tests_run')) is not int or type(r.get('tests_passed')) is not int or not 0 <= r['tests_passed'] <= r['tests_run']:
                raise ValueError('invalid test inventory')
            if not censored:
                tests.append(r['tests_run'])
                complete_tests.add(identity)
        if execution:
            work.append(duration.get('compute_seconds'))
        normalized_attempts.append({'repo': repo, 'pr': pr, 'head': head, 'lane': lane, 'attempt': attempt,
                                    'outcome': outcome or ('refused' if by_kind['refused'] else 'unknown'),
                                    'phases': sorted(times), 'durations': duration,
                                    'base': rows[0].get('base'), 'tree': rows[0].get('tree'),
                                    'censored': censored,
                                    'interventions': sorted({r['intervention'] for r in rows if
                                       isinstance(r.get('intervention'), str) and IDENTIFIER.fullmatch(r['intervention'])})})

    eligible, failed, unresolved, delivered = 0, 0, 0, 0
    pr_observations = defaultdict(list)
    ci_rounds = sum(len(c['ci']) for c in candidates.values())
    candidate_rows = []
    for (repo, pr, head), observations in sorted(candidates.items()):
        ci = sorted(observations['ci'])
        verdict = ci[0][3] if ci else 'unknown'  # never select a later green to erase first red/unknown
        pr_observations[(repo, pr)].append((ci[0][0] if ci else float('-inf'), verdict))
        if verdict in ('passed', 'failed'):
            eligible += 1
            failed += verdict == 'failed'
        else:
            unresolved += 1
        if observations['merged']:
            timing_expected['live_lag_seconds'] += 1
            if observations['delivered']:
                lag = min(observations['delivered']) - min(observations['merged'])
                if lag < 0:
                    raise ValueError('delivery predates merge')
                timings['live_lag_seconds'].append(lag)
        delivered += bool(observations['delivered'])
        candidate_rows.append({'repo': repo, 'pr': pr, 'head': head, 'first_ci': verdict,
                               'merged': bool(observations['merged']),
                               'delivery': 'verified' if observations['delivered'] else 'unknown'})
    total_work = sum(work) if work and all(number(v) for v in work) else None
    total_tests = sum(tests) if executions and complete_tests == executions and not unjoinable else None
    if unjoinable:
        total_work = None
    conservation = Counter(offered=0, pending=0, owned=0, terminal=0, unoffered=0)
    job_responses = []
    for (repo, job), rows in sorted(job_rows.items()):
        rows.sort(key=lambda r: (timestamp(r['at']), r['id']))
        offered = any(r['kind'] == 'offered' for r in rows)
        active = set()
        duplicate = False
        unreconciled = False
        state = 'pending'
        for row in rows:
            key = (row['lane'], row['attempt'])
            if row['kind'] == 'started':
                duplicate |= bool(active - {key})
                active.add(key)
                state = 'owned'
            elif row['kind'] in ('completed', 'refused', 'cancelled', 'superseded'):
                active.discard(key)
                state = 'owned' if active else 'pending'
            elif row['kind'] == 'job_terminal':
                unreconciled |= bool(active)
                state = 'owned' if active else 'terminal'
            elif row['kind'] == 'job_reopened':
                unreconciled |= bool(active)
                state = 'owned' if active else 'pending'
        conservation['offered' if offered else 'unoffered'] += 1
        if offered:
            conservation[state] += 1
        if not offered or duplicate or unreconciled:
            job_responses.append({'id': 'job-' + hashlib.sha256(f'{repo}:{job}'.encode()).hexdigest()[:20],
                                  'owner': 'orchestrator-maintainer', 'repo': repo, 'job': job,
                                  'remediation': 'Reconcile offered/owned/terminal job evidence and remove duplicate ownership before dispatch',
                                  'test': 'Replay dropped offer and overlapping attempts with this job identity',
                                  'clear': 'Complete journal proves one offered job, at most one owner and a reconciled terminal or wakeup'})
    pr_verdicts = [sorted(v)[0][1] for v in pr_observations.values()]
    eligible_prs = sum(v != 'unknown' for v in pr_verdicts)
    report = {'schema': 'orch-measurement/v1', 'status': 'observed' if attempts and not unjoinable else 'unknown',
            'rounds': dict(rounds), 'attempts': normalized_attempts,
            'candidate_rates': {'status': 'complete' if eligible and not unresolved and not unjoinable else 'unknown',
                                'eligible': eligible, 'unresolved': unresolved,
                                'first_ci_failed_fraction': failed / eligible if eligible else None,
                                'failed_candidates': failed, 'unit': 'repo/PR/head'},
            'pr_rates': {'eligible': eligible_prs, 'unresolved': pr_verdicts.count('unknown'),
                         'first_required_ci_failed_fraction': pr_verdicts.count('failed') / eligible_prs if eligible_prs else None,
                         'status': 'complete' if eligible_prs and 'unknown' not in pr_verdicts and not unjoinable else 'unknown'},
            'candidates': candidate_rows, 'started_executions': started_count, 'censored_executions': censored_count,
            'execution_evidence_attempts': len(executions),
            'ci_rounds': ci_rounds, 'same_head_ci_reruns': sum(max(0, len(c['ci']) - 1) for c in candidates.values()),
            'attempts_per_candidate': len(normalized_attempts) / len(candidates) if candidates else None,
            'verified_deliveries': delivered, 'unjoinable_records': unjoinable,
            'timings': {m: distribution(timings[m], timing_expected[m]) for m in METRICS},
            'work': {'total_compute_seconds': total_work, 'observed_tests': total_tests,
                     'compute_seconds_per_test': total_work / total_tests if total_work is not None and total_tests else None,
                     'compute_seconds_per_verified_delivery': total_work / delivered if total_work is not None and delivered else None},
            'usage': {m: {'observed': sum(v) if v else None, 'samples': len(v),
                         'total': sum(v) if executions and usage_complete[m] == executions and not unjoinable else None} for m, v in totals.items()},
            'conservation': dict(conservation), 'conservation_status': 'unknown' if unbound_jobs or unjoinable or not job_rows else 'breach' if job_responses else 'complete',
            'unbound_job_attempts': unbound_jobs, 'job_responses': job_responses,
            'performance_receipts': performance, 'diagnostics': artifacts,
            'retention': {'source_logs': 'read-only; never rewritten or deleted by measurement',
                          'reports': 'immutable per-output; retain final summaries/digests beyond intermediate expiry',
                          'consumption': 'unknown unless independently collected; no unused-artifact inference'}}
    if stratify:
        partitions = defaultdict(list)
        selected = {(a['repo'], a['pr'], a['lane'], a['attempt']) for a in normalized_attempts}
        for identity, rows in attempts.items():
            if identity not in selected:
                continue
            interventions = {r['intervention'] for r in rows if r.get('intervention') is not None}
            if len(interventions) > 1 or any(not isinstance(i, str) or not IDENTIFIER.fullmatch(i) for i in interventions):
                raise ValueError('invalid intervention identifier')
            intervention = next(iter(interventions), None)
            anchor = next((r for r in rows if r['kind'] == 'started'), rows[0])
            day = datetime.fromtimestamp(timestamp(anchor['at']), timezone.utc).date().isoformat()
            partitions[(anchor['repo'], anchor['lane'], intervention, day)].extend(rows)
        report['strata'] = [{'repo': k[0], 'lane': k[1], 'intervention': k[2], 'utc_day': k[3],
                             'measurement': measure(v, artifact_root, stratify=False, window=window)} for k, v in sorted(partitions.items(), key=lambda p: str(p[0]))]
        report['strata_attribution'] = 'whole attempt to execution-start UTC day, or first observation if no start'
    return report


def compare(baseline, current):
    """Observed end-to-end deltas, never a configuration score or a causal savings claim."""
    def fields(report):
        return {**{k: report['work'].get(k) for k in ('total_compute_seconds', 'observed_tests',
                                                       'compute_seconds_per_test', 'compute_seconds_per_verified_delivery')},
                'first_ci_failed_fraction': report['candidate_rates']['first_ci_failed_fraction'] if report['candidate_rates']['status'] == 'complete' else None,
                **{f'{m}.p95': report['timings'][m]['p95'] if report['timings'][m]['status'] == 'complete' else None for m in METRICS}}
    before, after = fields(baseline), fields(current)
    deltas = {k: {'before': before[k], 'after': after[k],
                  'delta': after[k] - before[k] if number(before[k]) and number(after[k]) else None} for k in before}
    return {'status': 'observed' if all(v['delta'] is not None for v in deltas.values()) else 'unknown',
            'metrics': deltas, 'candidate_rates': {'baseline': baseline['candidate_rates'], 'current': current['candidate_rates']},
            'causal_savings': 'unknown; require matched workload, environment and intervention evidence'}


def respond(report, policies, prior, window_id):
    """One owned response per policy; unknown never opens a decorative alert or clears a breach."""
    state = copy.deepcopy(prior) if prior else {'responses': {}, 'windows': {}}
    digest = hashlib.sha256(json.dumps({'report': report, 'policies': policies}, sort_keys=True).encode()).hexdigest()
    if window_id in state['windows']:
        if state['windows'][window_id] != digest:
            raise ValueError('window evidence changed')
        return state
    ids = set()
    for policy in policies:
        for field in ('id', 'metric', 'owner', 'remediation', 'test', 'clear'):
            if not isinstance(policy.get(field), str) or not policy[field].strip():
                raise ValueError('unowned or invalid policy')
        if policy['id'] in ids or not IDENTIFIER.fullmatch(policy['id']):
            raise ValueError('duplicate policy')
        ids.add(policy['id'])
        if not number(policy.get('max')) or type(policy.get('min_samples')) is not int or policy['min_samples'] <= 0 or type(policy.get('clear_windows')) is not int or policy['clear_windows'] <= 0:
            raise ValueError('invalid policy threshold')
        parts = policy['metric'].split('.')
        if len(parts) != 3 or parts[0] != 'timings' or parts[1] not in METRICS or parts[2] not in ('median', 'p95'):
            raise ValueError('unsupported policy metric')
        sample = report['timings'][parts[1]]
        response = state['responses'].get(policy['id'])
        if response and any(response.get(k) != v for k, v in policy.items()):
            raise ValueError('policy definition changed; use a new policy identity')
        if sample['status'] != 'complete' or report['unjoinable_records'] or sample['samples'] < policy['min_samples']:
            if response:
                response['clean_windows'] = 0
            continue
        value = sample[parts[2]]
        if value > policy['max']:
            state['responses'][policy['id']] = {**policy, 'status': 'open', 'clean_windows': 0,
                                               'evidence_window': window_id, 'observed': value,
                                               'heads': sorted({a['head'] for a in report['attempts']})}
        elif response and response['status'] == 'open':
            response['clean_windows'] += 1
            if response['clean_windows'] >= policy['clear_windows']:
                response['status'] = 'cleared'
                response['cleared_window'] = window_id
    state['windows'][window_id] = digest
    return state


def read_records(paths):
    records = []
    for path in paths:
        for line in Path(path).read_text().splitlines():
            if line.strip():
                records.append(json.loads(line))
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--events', action='append', default=[], help='Normalized or legacy delivery JSONL; repeatable')
    parser.add_argument('--artifact-root', help='Explicit receipt store; no product/store access')
    parser.add_argument('--failure-audit', help='Audit Markdown with embedded captured evidence, or failure-rounds/v1 JSON')
    parser.add_argument('--bug-counts', help='Separate bug-study/v1 aggregate JSON')
    parser.add_argument('--baseline', help='Previous measurement JSON for end-to-end observed deltas')
    parser.add_argument('--start', help='Inclusive timestamp for an explicit observation window')
    parser.add_argument('--cutoff', help='Inclusive captured timestamp; partial/censored work stays unknown')
    parser.add_argument('--policies', help='JSON array of owned latency policies')
    parser.add_argument('--prior-responses', help='Previous response JSON; never modified')
    parser.add_argument('--window-id', help='Unique bounded observation window, required for policies')
    parser.add_argument('--output', help='New immutable report path; existing reports are never overwritten')
    args = parser.parse_args()
    try:
        records = read_records(args.events)
        if bool(args.start) != bool(args.cutoff):
            raise ValueError('both window bounds are required')
        window = None
        if args.start:
            start, cutoff = timestamp(args.start), timestamp(args.cutoff)
            if start > cutoff:
                raise ValueError('invalid window')
            window = (start, cutoff)
        report = measure(records, args.artifact_root, window=window)
        report['window'] = {'start': args.start, 'cutoff': args.cutoff, 'baseline': 'unestablished; disclose interventions and incomplete days'}
        if args.failure_audit:
            path = Path(args.failure_audit)
            audit = json.loads(path.read_text()) if path.suffix == '.json' else decode_audit(path)
            bugs = read_bug_counts(args.bug_counts) if args.bug_counts else None
            report['historical'] = historical(audit, bugs)
        if args.baseline:
            report['comparison'] = compare(json.loads(Path(args.baseline).read_text()), report)
        if args.policies:
            if not args.window_id:
                raise ValueError('policies require window identity')
            policies = json.loads(Path(args.policies).read_text())
            prior = json.loads(Path(args.prior_responses).read_text()) if args.prior_responses else {}
            prior = prior.get('response_state', prior)
            report['response_state'] = respond(report, policies, prior, args.window_id)
        if args.output:
            save_immutable(args.output, report)
        print(json.dumps(report, sort_keys=True, allow_nan=False))
        return 0
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError, OverflowError, RecursionError, zlib.error):
        # Do not serialize raw input, error messages, receipt paths or subprocess stderr.
        print(json.dumps({'schema': 'orch-measurement/v1', 'status': 'unknown', 'error': 'invalid or unreadable evidence'}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
