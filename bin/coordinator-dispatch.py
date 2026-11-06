#!/usr/bin/env python3
"""Mint one CARR card and publish its worker brief. Delegation stays with the caller."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from uuid import UUID

TEMPLATES = Path(__file__).resolve().parent / 'dispatch-templates'
NAMES = ('build', 'review', 'fix', 'open-held-branch')
PLACEHOLDER = re.compile(r'\{\{([a-z_]+)\}\}')
CARD = re.compile(r'WR([1-9]\d*)\.S([1-9]\d*)\.J([1-9]\d*)')


def render(template, variables):
    missing = set(PLACEHOLDER.findall(template)) - variables.keys()
    if missing:
        raise ValueError('missing template variables: ' + ', '.join(sorted(missing)))
    text = PLACEHOLDER.sub(lambda match: variables[match[1]], template)
    if len(re.findall(r'^Card:.*$', text, re.MULTILINE)) != 1:
        raise ValueError('brief must contain exactly one standalone Card line')
    return text


def publish(path, text):
    data = text.encode()
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError('brief conflict at ' + str(path))
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
        temporary = Path(out.name)
        try:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
            try:
                os.link(temporary, path)
            except FileExistsError:
                if path.read_bytes() != data:
                    raise ValueError('brief conflict at ' + str(path)) from None
        finally:
            temporary.unlink()


def prepare(args):
    request = json.loads(args.request.read_text())
    if not isinstance(request, dict) or set(request) != {'card', 'template', 'variables'}:
        raise ValueError('request requires card, template, variables')
    card, variables = request['card'], request['variables']
    if not isinstance(card, dict) or not isinstance(variables, dict):
        raise ValueError('card and variables must be objects')
    if any(not isinstance(k, str) or not isinstance(v, str) for k, v in variables.items()):
        raise ValueError('template variables must be strings')
    if any('Card:' in value for value in variables.values()):
        raise ValueError('Card marker is reserved for the generated header')
    if 'card_id' in variables or 'runner_job_id' in card or 'job' in card:
        raise ValueError('mint only; card_id is reserved and runner/job starts are forbidden')
    key = str(UUID(card['idempotency_key']))
    work_request = re.fullmatch(r'WR-?(\d{1,6})', card.get('work_request', ''))
    ordinal = card.get('slice', 1)
    if not work_request or int(work_request[1]) < 1 or type(ordinal) is not int or ordinal < 1:
        raise ValueError('invalid work_request or slice')
    if request['template'] not in NAMES:
        raise ValueError('unknown template')
    template = (TEMPLATES / 'common.md').read_text() + '\n' + (TEMPLATES / (request['template'] + '.md')).read_text()
    variables = {**variables, 'repository': card['repository'], 'poteto_skill': str(Path.home() / '.claude/plugins/marketplaces/cursor-plugins/pstack/skills/poteto-mode/SKILL.md'), 'preferences': str(Path.home() / '.claude/orchestrate/doctorcre-delivery/preferences.md')}
    render(template, {**variables, 'card_id': 'WR1.S1.J1'})
    destinations = [args.tmp_dir.resolve(), args.brief_dir.expanduser().resolve()]
    for folder in destinations:
        folder.mkdir(parents=True, exist_ok=True)
    fingerprint = json.dumps([request, template, variables, list(map(str, destinations))], sort_keys=True)
    receipts = destinations[1] / '.requests'
    receipts.mkdir(exist_ok=True)
    receipt = receipts / (key + '.json')
    descriptor = os.open(receipts / (key + '.lock'), os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(descriptor, 'r+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('request is already running; retry the same UUID after it finishes') from None
        previous = receipt.read_text() if receipt.exists() else None
        saved = json.loads(previous) if previous is not None else {'fingerprint': fingerprint}
        if saved['fingerprint'] != fingerprint:
            raise ValueError('idempotency key already binds a different request or template')

        def save():
            with tempfile.NamedTemporaryFile(mode='w', dir=receipts, delete=False) as out:
                temporary = Path(out.name)
                try:
                    json.dump(saved, out)
                    out.flush()
                    os.fsync(out.fileno())
                    os.replace(temporary, receipt)
                    directory = os.open(receipts, os.O_RDONLY)
                    try:
                        os.fsync(directory)
                    finally:
                        os.close(directory)
                finally:
                    temporary.unlink(missing_ok=True)

        if previous is None:
            save()
        response = saved.get('response')
        if response is None:
            result = subprocess.run([str(args.carr_root.expanduser().resolve() / 'run.sh'), 'call', 'dispatch-job', json.dumps(card)],
                                    cwd=args.carr_root.expanduser(), capture_output=True, text=True, timeout=args.timeout)
            if result.returncode:
                raise ValueError('dispatch-job refused or failed; inspect CARR with the same idempotency key')
            response = json.loads(result.stdout)
        if not isinstance(response, dict) or response.get('ok') is not True:
            raise ValueError('dispatch-job did not return success')
        identifier = response.get('card_id')
        match = CARD.fullmatch(identifier) if isinstance(identifier, str) else None
        if not match or (int(match[1]), int(match[2])) != (int(work_request[1]), ordinal):
            raise ValueError('dispatch-job returned an invalid or mismatched card')
        if 'response' not in saved:
            saved['response'] = response
            save()
        text = render(template, {**variables, 'card_id': identifier})
        paths = [folder / ('brief-' + identifier + '.md') for folder in destinations]
        for path in paths:
            if path.exists() and path.read_text() != text:
                raise ValueError('brief conflict at ' + str(path))
        for path in paths:
            publish(path, text)
        if any(path.read_text() != text for path in paths):
            raise ValueError('brief readback mismatch')
        return identifier + ' ' + str(paths[0])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request', type=Path, help='JSON with card, template, variables')
    parser.add_argument('--carr-root', type=Path, default=Path.home() / 'carr-system')
    parser.add_argument('--tmp-dir', type=Path, default=Path('/tmp'))
    parser.add_argument('--brief-dir', type=Path, default=Path.home() / '.claude/orchestrate/doctorcre-delivery/briefs')
    parser.add_argument('--timeout', type=float, default=30, help='CARR call deadline in seconds, at most 30')
    args = parser.parse_args()
    try:
        if not 0 < args.timeout <= 30:
            raise ValueError('timeout must be greater than zero and at most 30')
        output = prepare(args)
    except subprocess.TimeoutExpired:
        print('dispatch timed out; the mint may have committed. Retry with the same UUID.', file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError) as error:
        print('dispatch failed: ' + str(error), file=sys.stderr)
        return 1
    print(output)
    return 0


if __name__ == '__main__':
    sys.exit(main())
