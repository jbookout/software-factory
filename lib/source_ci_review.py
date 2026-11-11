"""Durable admission of CARR candidates; the trusted host owns platform calls."""
from dataclasses import asdict, dataclass
import hashlib
import json
import re
import sqlite3

SHA = re.compile(r'[0-9a-f]{40}')
CARD = re.compile(r'WR[1-9][0-9]*\.S[1-9][0-9]*\.J[1-9][0-9]*')
REPO = 'DoctorCRE/carr-system'


def validate(candidate):
    if not isinstance(candidate, dict):
        raise ValueError('invalid candidate')
    for field in ('pull_request', 'source_run_id', 'source_run_attempt'):
        if type(candidate.get(field)) is not int or candidate[field] < 1:
            raise ValueError('invalid candidate integer')
    if (candidate.get('schema') != 'carr-source-ci-review-candidate.v1'
            or candidate.get('state') != 'candidate'
            or candidate.get('repository') != REPO
            or type(candidate.get('review_round')) is not int
            or candidate['review_round'] != 1
            or not isinstance(candidate.get('head_sha'), str)
            or not SHA.fullmatch(candidate['head_sha'])):
        raise ValueError('invalid candidate identity')
    key = hashlib.sha256(
        f"{REPO}:{candidate['pull_request']}:{candidate['head_sha']}:1".encode()).hexdigest()
    if candidate.get('request_key') != key:
        raise ValueError('invalid request key')
    fields = ('schema', 'state', 'repository', 'pull_request', 'head_sha',
              'review_round', 'request_key', 'source_run_id', 'source_run_attempt')
    return {field: candidate[field] for field in fields}


@dataclass(frozen=True)
class Binding:
    builder_card: str
    builder_executor: str
    reviewer_card: str
    reviewer_executor: str

    def validate(self):
        if (not all(isinstance(v, str) and v and len(v) <= 256
                    and not any(c.isspace() for c in v) for v in asdict(self).values())
                or not CARD.fullmatch(self.builder_card)
                or not CARD.fullmatch(self.reviewer_card)
                or self.builder_card == self.reviewer_card
                or self.builder_executor == self.reviewer_executor):
            raise ValueError('unknown or non-independent provenance')


@dataclass(frozen=True)
class Launch:
    task_id: str
    thread_id: str

    def validate(self):
        if not all(isinstance(v, str) and v and len(v) <= 256
                   for v in asdict(self).values()):
            raise ValueError('missing T3 acceptance identity')


class Consumer:
    """One local durable ledger shared by all deliveries on the trusted host."""

    def __init__(self, path, revision):
        if not SHA.fullmatch(revision):
            raise ValueError('full pinned factory revision required')
        self.revision = revision
        self.db = sqlite3.connect(path, timeout=5, isolation_level=None)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS reviews '
                        '(request_key TEXT PRIMARY KEY, receipt TEXT NOT NULL)')

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.db.close()

    def receipt(self, key):
        row = self.db.execute('SELECT receipt FROM reviews WHERE request_key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def _save(self, receipt, state, **updates):
        receipt.update(state=state, **updates)
        self.db.execute('UPDATE reviews SET receipt=? WHERE request_key=?',
                        (json.dumps(receipt, sort_keys=True), receipt['candidate']['request_key']))
        return receipt

    def consume(self, artifact, host):
        """Host collect/admit/launch are trusted, bounded synchronous adapters.

        collect reruns the pinned CARR collector against live GitHub metadata.
        admit resolves builder provenance and dispatches a registered reviewer
        Card with the supplied stable key. launch invokes T3 delegate_task.
        No adapter or instruction is taken from event/artifact data.
        """
        candidate = validate(artifact)
        key = candidate['request_key']
        existing = self.receipt(key)
        if existing:
            return existing
        if host.collect(candidate['source_run_id'], candidate['source_run_attempt']) != candidate:
            return {'state': 'refused', 'reason': 'source-not-current'}
        receipt = dict(state='admitting', candidate=candidate, launcher_revision=self.revision)
        inserted = self.db.execute('INSERT OR IGNORE INTO reviews VALUES (?, ?)',
                                   (key, json.dumps(receipt))).rowcount
        if not inserted:
            return self.receipt(key)
        try:
            binding = host.admit(candidate, key)
            binding.validate()
            self._save(receipt, 'admitted', binding=asdict(binding))
            if host.collect(candidate['source_run_id'], candidate['source_run_attempt']) != candidate:
                return self._save(receipt, 'superseded')
            request = {
                'clientRequestId': key, 'isolation': 'worktree', 'role': 'review',
                'task': (f"Independently review {REPO} PR {candidate['pull_request']} at "
                         f"{candidate['head_sha']}. Verify this exact head and source CI. "
                         "Read the repository guidance. Start no subagents. "
                         "Do not submit reviews, merge, arm, or use production credentials. "
                         "Return findings and exact-head empirical attestation.\n\n"
                         f"Card: {binding.reviewer_card}\n"),
            }
            self._save(receipt, 'launching')
            launch = host.launch(request, binding)
            launch.validate()
            return self._save(receipt, 'launched', launch=asdict(launch))
        except Exception as error:
            return self._save(receipt, 'held', reason=type(error).__name__)


def prove(receipt, candidate, revision):
    """Validate receipt bindings, not remote execution or a native verdict."""
    try:
        expected = validate(candidate)
        actual = validate(receipt['candidate'])
        Binding(**receipt['binding']).validate()
        Launch(**receipt['launch']).validate()
        return (receipt['state'] == 'launched' and actual == expected
                and bool(SHA.fullmatch(revision)) and receipt['launcher_revision'] == revision)
    except (KeyError, TypeError, ValueError):
        return False
