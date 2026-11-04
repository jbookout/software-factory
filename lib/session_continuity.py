"""Development-only continuity policy and private fixture checkpoint store."""
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
import stat
from pathlib import Path

from lib.session_adapters import claude, codex, grok

MAX_INPUT = 65536
MAX_CHECKPOINT = 32768
RETENTION = 8
ROLES = {'coordinator', 'user', 'builder', 'reviewer', 'verifier', 't3-worker', 'native-subagent', 'remote-worker'}
ADAPTERS = {'claude': claude, 'codex': codex, 'grok': grok}
HARNESSES = {'claude': {'hooks'}, 'codex': {'hooks', 'app-server'}, 'grok': {'hooks', 'acp'}}
BINDING_FIELDS = {'provider', 'provider_instance', 'harness', 'environment', 'native_session_id', 'role', 'thread_id', 'task_id', 'parent_destination', 'card', 'worktree', 'repository_revision', 'lease_refs'}
OPTIONAL_IDENTITIES = {'thread_id', 'task_id', 'parent_destination', 'card', 'worktree', 'repository_revision'}
CHECKPOINT_FIELDS = {'acceptance', 'corrections', 'decisions', 'next_action', 'evidence_refs', 'active_operations', 'exact_jobs', 'destinations', 'watches', 'links', 'revisions', 'cards', 'leases'}


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def integer(value):
    return type(value) is int and 0 <= value <= 2**63 - 1


def binding_key(binding):
    if not isinstance(binding, dict) or set(binding) != BINDING_FIELDS:
        raise ValueError('invalid_binding')
    if binding.get('role') == 't3-worker' and any(binding.get(k) is None for k in OPTIONAL_IDENTITIES):
        raise ValueError('incomplete_worker_binding')
    if any(not isinstance(binding[k], str) or not 0 < len(binding[k]) <= 1024 for k in BINDING_FIELDS - {'lease_refs'} if not (k in OPTIONAL_IDENTITIES and binding[k] is None)):
        raise ValueError('invalid_binding')
    if not isinstance(binding['lease_refs'], list) or len(binding['lease_refs']) > 32 or any(not isinstance(v, str) or len(v) > 1024 for v in binding['lease_refs']):
        raise ValueError('invalid_binding')
    if binding['provider'] not in ADAPTERS or binding['harness'] not in HARNESSES[binding['provider']] or binding['role'] not in ROLES:
        raise ValueError('unsupported_binding')
    return digest({k: binding[k] for k in ('provider', 'provider_instance', 'harness', 'environment', 'native_session_id')})


@dataclass(frozen=True)
class Event:
    used: int | None
    window: int | None
    compact_at: int | None
    kind: str
    telemetry: str


def normalize(envelope):
    binding = envelope['binding']
    binding_key(binding)
    payload = envelope.get('payload')
    if not isinstance(payload, dict):
        raise ValueError('invalid_payload')
    used, window, kind, native_id = ADAPTERS[binding['provider']].normalize(payload, binding['harness'])
    if kind not in ('usage', 'before_compact') or native_id != binding['native_session_id'] or kind != envelope.get('kind'):
        raise ValueError('native_event_binding_mismatch')
    observed, now = envelope.get('observed_at'), envelope.get('now')
    telemetry = 'fresh'
    if not integer(observed) or not integer(now) or not 0 <= now - observed <= 60:
        telemetry = 'stale_usage'
    if 'auto_compact_at' in envelope and not integer(envelope['auto_compact_at']):
        telemetry = 'unknown_compaction_boundary'
    if not isinstance(envelope.get('model_fingerprint'), str) or not envelope['model_fingerprint'] or envelope.get('usage_model_fingerprint') != envelope['model_fingerprint']:
        telemetry = 'model_changed'
    return Event(used if integer(used) else None,
                 window if integer(window) and window > 0 else None,
                 envelope.get('auto_compact_at') if integer(envelope.get('auto_compact_at')) else None,
                 kind, telemetry)


def decide(event, epoch_known):
    if not epoch_known:
        return {'status': 'unknown', 'reason': 'unknown_epoch'}
    if event.kind == 'before_compact':
        return {'status': 'persist', 'reason': 'native_boundary', 'protection': 'unknown' if event.telemetry != 'fresh' or event.used is None or event.window is None else 'observed'}
    if event.telemetry != 'fresh':
        return {'status': 'unknown', 'reason': event.telemetry}
    if event.used is None or event.window is None:
        return {'status': 'unknown', 'reason': 'unknown_usage_or_window'}
    threshold = min(500000, event.window - 50000,
                    event.compact_at - 50000 if event.compact_at is not None else 500000)
    return {'status': 'persist' if event.used >= max(0, threshold) else 'continue',
            'reason': 'threshold' if event.used >= max(0, threshold) else 'below_threshold',
            'threshold': max(0, threshold)}


def validate_checkpoint(checkpoint):
    if not isinstance(checkpoint, dict) or set(checkpoint) != CHECKPOINT_FIELDS or len(encoded(checkpoint)) > MAX_CHECKPOINT:
        raise ValueError('invalid_checkpoint')
    for key, value in checkpoint.items():
        if key == 'next_action':
            if not isinstance(value, str):
                raise ValueError('invalid_checkpoint')
        elif not isinstance(value, list) or len(value) > 64 or any(not isinstance(v, str) for v in value):
            raise ValueError('invalid_checkpoint')


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.is_symlink() or self.root.stat().st_mode & 0o077:
            raise ValueError('store_must_be_private')

    def directory(self, binding):
        directory = self.root / binding_key(binding)
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink() or directory.stat().st_mode & 0o077:
            raise ValueError('session_store_must_be_private')
        return directory

    def read(self, directory):
        path = directory / 'checkpoint.json'
        if path.is_symlink():
            raise ValueError('unsafe_store_file')
        if not path.exists():
            return None
        if path.stat().st_size > MAX_INPUT * 2:
            raise ValueError('corrupt_store')
        state = json.loads(path.read_bytes())
        if not isinstance(state, dict) or not all(integer(state.get(k)) for k in ('generation', 'epoch', 'cursor')):
            raise ValueError('corrupt_store')
        binding_key(state['binding'])
        if state['checkpoint'] is not None:
            validate_checkpoint(state['checkpoint'])
        if state['checkpoint_digest'] != (digest(state['checkpoint']) if state['checkpoint'] is not None else None):
            raise ValueError('corrupt_store')
        return state

    @staticmethod
    def sync_directory(directory):
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def save(self, envelope, event, decision, fault=None):
        directory = self.directory(envelope['binding'])
        lock_path = directory / 'lock'
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'r+') as lock:
            for attempt in range(2):
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if attempt:
                        return {'status': 'degraded', 'reason': 'store_busy'}
            state = self.read(directory)
            event_digest = digest({k: v for k, v in envelope.items() if k not in ('now', 'expected_generation')})
            if state:
                if state['binding'] != envelope['binding']:
                    return {'status': 'degraded', 'reason': 'ownership_changed'}
                if envelope['epoch'] < state['epoch'] or envelope['cursor'] < state['cursor']:
                    return {'status': 'degraded', 'reason': 'old_replay'}
                if envelope['cursor'] == state['cursor']:
                    if event_digest != state['event_digest']:
                        return {'status': 'degraded', 'reason': 'changed_replay'}
                    self.sync_directory(directory)
                    return self.saved(self.read(directory), decision) if decision['status'] == 'persist' else decision
                if envelope['epoch'] == state['epoch'] and envelope['model_fingerprint'] == state['model_fingerprint'] and event.window == state['window'] and event.telemetry == 'fresh' and state['used'] is not None and event.used is not None and event.used < state['used']:
                    return {'status': 'unknown', 'reason': 'counter_reset_without_new_epoch'}
            generation = state['generation'] if state else 0
            if envelope['expected_generation'] != generation:
                return {'status': 'degraded', 'reason': 'cas_conflict', 'generation': generation}
            receipts = state['recent_events'] if state else []
            persist = decision['status'] == 'persist'
            checkpoint = envelope['checkpoint'] if persist else state['checkpoint'] if state else None
            record = dict(binding=envelope['binding'], epoch=envelope['epoch'], cursor=envelope['cursor'],
                          generation=generation + int(persist), checkpoint=checkpoint,
                          checkpoint_digest=digest(checkpoint) if checkpoint is not None else None,
                          checkpoint_event_digest=event_digest if persist else state['checkpoint_event_digest'] if state else None,
                          event_digest=event_digest, model_fingerprint=envelope['model_fingerprint'], window=event.window,
                          used=event.used, recent_events=(receipts + [event_digest])[-RETENTION:])
            temporary = directory / '.checkpoint-pending'
            try:
                output_fd = os.open(temporary, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
                with os.fdopen(output_fd, 'wb') as output:
                    metadata = os.fstat(output.fileno())
                    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_nlink != 1:
                        raise ValueError('unsafe_store_file')
                    os.fchmod(output.fileno(), 0o600)
                    output.truncate(0)
                    output.write(encoded(record))
                    output.flush()
                    os.fsync(output.fileno())
                if fault:
                    fault('before_replace')
                os.replace(temporary, directory / 'checkpoint.json')
                if fault:
                    fault('after_replace')
                self.sync_directory(directory)
                readback = self.read(directory)
                if readback != record:
                    raise ValueError('readback_mismatch')
                if fault:
                    fault('after_readback')
                result = self.saved(readback, decision) if persist else decision
                if fault:
                    fault('after_receipt')
                return result
            finally:
                if temporary and os.path.exists(temporary):
                    os.unlink(temporary)

    @staticmethod
    def saved(state, decision):
        return {'status': 'saved', 'decision': decision, 'checkpoint': state['checkpoint'],
                'receipt': dict(checkpoint_digest=state['checkpoint_digest'], generation=state['generation'],
                                binding_digest=digest(state['binding']), source_event_ref=state['checkpoint_event_digest'],
                                durable_readback=True, native_delivery='pending')}

    def recover(self, binding):
        state = self.read(self.directory(binding))
        if not state or state['checkpoint'] is None:
            return {'status': 'unknown', 'reason': 'no_checkpoint'}
        if state['binding'] != binding:
            return {'status': 'degraded', 'reason': 'ownership_changed'}
        self.sync_directory(self.directory(binding))
        result = self.saved(state, {'status': 'restore'})
        result['recovery_output'] = ADAPTERS[binding['provider']].render(result['checkpoint'], result['receipt'])
        result['recovery_support'] = 'artifact_only' if result['recovery_output'] is not None else 'unsupported'
        return result


def process(envelope, store, fault=None):
    if len(encoded(envelope)) > MAX_INPUT:
        raise ValueError('input_too_large')
    if envelope.get('schema_version') != 1 or type(envelope.get('schema_version')) is not int:
        raise ValueError('unsupported_schema')
    event = normalize(envelope)
    decision = decide(event, integer(envelope.get('epoch')) and isinstance(envelope.get('epoch_evidence'), str) and 0 < len(envelope['epoch_evidence']) <= 1024)
    if decision['status'] not in ('persist', 'continue'):
        return decision
    if not integer(envelope.get('cursor')) or not integer(envelope.get('expected_generation')):
        raise ValueError('invalid_cursor_or_generation')
    if decision['status'] == 'persist':
        validate_checkpoint(envelope.get('checkpoint'))
    return store.save(envelope, event, decision, fault)
