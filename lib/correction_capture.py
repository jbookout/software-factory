"""Bounded session evidence and sponsored correction review. No adoption authority."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import uuid
from contextlib import contextmanager

MAX_BYTES = 8 * 1024 * 1024
MAX_ROWS = 20000
MACHINE = re.compile(
    r'^\s*(?:<[^>]+>|Stop hook|PreToolUse|PostToolUse|'
    r'\[SYSTEM NOTIFICATION|\[Request interrupted|\[Image:|'
    r'Another Claude session sent a message:|The following is the Codex agent history|'
    r'SEND THE DELTA, NOT THE MESSAGE AGAIN|\[/usr/bin/|'
    r'The previous response failed to produce|This session is being continued from|'
    r'Please continue the conversation from|Continue from where you left off|'
    r'Base directory for this skill:|Caveat: The messages below|'
    r'#\s*\w[\w ]*Skill\b|Approach this as the\b|# AGENTS.md instructions for )', re.I)
SHOUTED = re.compile(r'^(?:[A-Z][A-Z ]{3,}GATE\b|DELEGATION TRIPWIRE\b|WRITE LAW\b)')


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _user_text(row, provider, meta):
    if provider == 'claude':
        if row.get('type') != 'user' or row.get('isSidechain'):
            return None
        content = row.get('message', {}).get('content', [])
    else:
        if isinstance(meta.get('source'), dict) and 'subagent' in meta['source']:
            return None
        payload = row.get('payload', {})
        if row.get('type') != 'response_item' or payload.get('type') != 'message' or payload.get('role') != 'user':
            return None
        content = payload.get('content', [])
    if isinstance(content, list) and any(b.get('type') == 'tool_result' for b in content if isinstance(b, dict)):
        return None
    if isinstance(content, list):
        content = '\n'.join(b['text'] for b in content if isinstance(b, dict)
                            and b.get('type') in {'text', 'input_text'} and isinstance(b.get('text'), str))
    if not isinstance(content, str):
        raise ValueError('invalid native content')
    content = content.strip()
    if not content or MACHINE.search(content) or SHOUTED.search(content):
        return None
    return content


@contextmanager
def _database(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    os.close(fd)
    if path.stat().st_mode & 0o077:
        raise ValueError('queue must be private')
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS items (
                id TEXT PRIMARY KEY, provider TEXT, session TEXT, turn TEXT, text TEXT,
                source TEXT, state TEXT DEFAULT 'queued', disposition TEXT,
                evidence TEXT, adopted_match INTEGER DEFAULT 0, intent TEXT, receipt TEXT,
                cause TEXT, failures INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS diagnoses (
                item TEXT, cause TEXT, PRIMARY KEY(item, cause));
        ''')
        yield db
    finally:
        db.close()


def capture(transcript, provider, session, queue):
    if provider not in {'claude', 'codex'} or not isinstance(session, str) or not session:
        raise ValueError('provider and session required')
    path = Path(transcript)
    with path.open('rb') as handle:
        data = handle.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('transcript exceeds byte bound')
    lines = data.decode('utf-8').splitlines()
    if len(lines) > MAX_ROWS:
        raise ValueError('transcript exceeds row bound')
    turns = []
    meta = {}
    for number, line in enumerate(lines, 1):
        row = json.loads(line)
        if not isinstance(row, dict):
            raise ValueError('native row must be object')
        if row.get('type') == 'session_meta':
            meta = row.get('payload', {})
            if not isinstance(meta, dict) or meta.get('id') != session:
                raise ValueError('session metadata mismatch')
        if provider == 'codex' and not meta:
            raise ValueError('Codex session metadata required')
        if provider == 'claude' and row.get('sessionId', session) != session:
            raise ValueError('session mismatch')
        text = _user_text(row, provider, meta)
        if text is None:
            continue
        turn = row.get('uuid') or row.get('id') or row.get('timestamp') or f'line:{number}'
        key = _digest([provider, session, turn])
        source = json.dumps({'path': str(path.absolute()), 'line': number, 'digest': _digest(row)})
        turns.append((key, provider, session, str(turn), text, source))
    with _database(queue) as db, db:
        db.execute('BEGIN IMMEDIATE')
        count = 0
        for turn in turns:
            existing = db.execute('SELECT text, source FROM items WHERE id=?', (turn[0],)).fetchone()
            if existing and (existing['text'] != turn[4] or json.loads(existing['source'])['digest'] != json.loads(turn[5])['digest']):
                raise ValueError('source identity changed')
            count += db.execute('INSERT OR IGNORE INTO items(id,provider,session,turn,text,source) VALUES(?,?,?,?,?,?)', turn).rowcount
    return count


def _item(row):
    item = dict(row)
    for key in ('source', 'intent', 'receipt'):
        if item[key]:
            item[key] = json.loads(item[key])
    item['adopted_match'] = bool(item['adopted_match'])
    return item


def inspect_queue(queue, limit=1000):
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError('inspection limit must be 1 through 1000')
    with _database(queue) as db:
        return {'items': [_item(r) for r in db.execute('SELECT * FROM items ORDER BY rowid LIMIT ?', (limit,))],
                'total': db.execute('SELECT count(*) FROM items').fetchone()[0],
                'unfinished': db.execute("SELECT count(*) FROM items WHERE state!='complete'").fetchone()[0],
                'diagnoses': [dict(r) for r in db.execute('SELECT * FROM diagnoses LIMIT ?', (limit,))]}


def _review(db, item, sponsor):
    snapshot = sponsor.snapshot()
    if snapshot.get('complete') is not True:
        raise ValueError('complete current rule snapshot required')
    rules = snapshot['rules']
    proposals = snapshot['proposals']
    judgment = sponsor.review(item, snapshot)
    evidence = judgment.get('evidence')
    if not isinstance(evidence, str) or not evidence.strip():
        raise ValueError('review evidence required')
    kind = judgment['kind']
    if kind == 'reject':
        state, adopted_match = 'rejected', False
    elif kind == 'match':
        ref = judgment['ref']
        active = any(r['id'] == ref and r.get('status') == 'active' and r.get('adopted') is True for r in rules)
        pending = any(r['id'] == ref and r.get('status') == 'proposed' for r in proposals)
        if not active and not pending:
            raise ValueError('match is not a current adopted rule or pending proposal')
        state, adopted_match = ('matched', True) if active else ('proposed', False)
        evidence += '\nReference: ' + ref
    elif kind == 'propose':
        statement = judgment['statement']
        if not isinstance(statement, str) or not statement.strip() or '\n' in statement:
            raise ValueError('single convention statement required')
        key = str(uuid.uuid5(uuid.NAMESPACE_URL, 'correction:' + item['id']))
        body = 'Convention: ' + statement + '\n\nEvidence: ' + evidence
        body += '\nSource: ' + json.dumps({k: item[k] for k in ('provider', 'session', 'turn', 'source', 'text')}, ensure_ascii=False)
        intent = {'idempotency_key': key, 'document': 'team-memory',
                  'section_key': 'conventions/proposed/correction-' + item['id'],
                  'body_text': body, 'base_version': 0, 'attach_id': sponsor.attach_id}
        with db:
            db.execute("UPDATE items SET state='publishing', evidence=?, intent=? WHERE id=?",
                       (evidence, json.dumps(intent), item['id']))
        return
    else:
        raise ValueError('unknown review disposition')
    with db:
        db.execute('UPDATE items SET state=?, disposition=?, evidence=?, adopted_match=? WHERE id=?',
                   (state, state, evidence, adopted_match, item['id']))


def consume(queue, sponsor, limit=100):
    """Run one bounded wake. Sponsor is trusted process code, never hook input."""
    if sponsor.access != 'read_write' or not sponsor.attach_id:
        raise PermissionError('sponsored read_write context required')
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError('batch limit must be 1 through 100')
    lock_path = Path(str(queue) + '.consumer.lock')
    lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with _database(queue) as db:
            ids = [r['id'] for r in db.execute("SELECT id FROM items WHERE state!='complete' ORDER BY rowid LIMIT ?", (limit,))]
            for identity in ids:
                stage = 'review'
                try:
                    item = _item(db.execute('SELECT * FROM items WHERE id=?', (identity,)).fetchone())
                    if item['state'] == 'queued':
                        _review(db, item, sponsor)
                        item = _item(db.execute('SELECT * FROM items WHERE id=?', (identity,)).fetchone())
                    if item['state'] == 'publishing':
                        stage = 'publication'
                        receipt = sponsor.call('write-doctrine-section', item['intent'])
                        if receipt.get('ok') is not True or not receipt.get('section_id'):
                            raise ValueError('publication receipt required')
                        with db:
                            db.execute("UPDATE items SET state='proposed', disposition='proposed', receipt=? WHERE id=?",
                                       (json.dumps(receipt), identity))
                    stage = 'wake'
                    if sponsor.wake('correction:' + identity).get('ok') is not True:
                        raise ValueError('wake receipt required')
                    with db:
                        db.execute("UPDATE items SET state='complete', cause=NULL, failures=0 WHERE id=?", (identity,))
                except Exception as exc:
                    cause = stage + ':' + type(exc).__name__
                    with db:
                        db.execute('UPDATE items SET failures=CASE WHEN cause=? THEN failures+1 ELSE 1 END, cause=? WHERE id=?',
                                   (cause, cause, identity))
                        db.execute('INSERT OR IGNORE INTO diagnoses SELECT id, cause FROM items WHERE id=? AND failures>=2', (identity,))
    return inspect_queue(queue)
