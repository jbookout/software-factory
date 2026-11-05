#!/usr/bin/env python3
"""Read-only installed identity, registered-card and brief readback proof."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 1048576


def read(path):
    with path.open('rb') as source:
        data = source.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('artifact exceeds 1 MiB')
    return data


def prove(args):
    spec = importlib.util.spec_from_file_location('dispatch', ROOT / 'bin/coordinator-dispatch.py')
    dispatch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dispatch)
    if not dispatch.CARD.fullmatch(args.card):
        raise ValueError('invalid canonical card')
    paths = ['bin/coordinator-dispatch.py', 'bin/prove-coordinator-dispatch.py'] + [
        'bin/dispatch-templates/' + name + '.md' for name in ('common', *dispatch.NAMES)]
    for name in paths:
        if read(args.installed_root / name) != read(ROOT / name):
            raise ValueError('installed identity mismatch: ' + name)
    request = json.loads(read(args.request))
    if request['template'] not in dispatch.NAMES:
        raise ValueError('unknown template')
    match = dispatch.CARD.fullmatch(args.card)
    work_request = request['card']['work_request'].replace('-', '')
    if int(match[1]) != int(work_request[2:]) or int(match[2]) != request['card'].get('slice', 1):
        raise ValueError('request card mismatch')
    key = str(UUID(request['card']['idempotency_key']))
    saved = json.loads(read(args.brief_dir / '.requests' / (key + '.json')))
    original, template, variables, destinations = json.loads(saved['fingerprint'])
    if original != request or saved['response'].get('ok') is not True or saved['response']['card_id'] != args.card:
        raise ValueError('receipt request or card mismatch')
    expected_template = (ROOT / 'bin/dispatch-templates/common.md').read_text() + '\n' + (
        ROOT / 'bin/dispatch-templates' / (request['template'] + '.md')).read_text()
    if template != expected_template or destinations != [str(args.tmp_dir.resolve()), str(args.brief_dir.resolve())]:
        raise ValueError('receipt template or destinations mismatch')
    if any(variables.get(k) != v for k, v in request['variables'].items()):
        raise ValueError('receipt variables mismatch')
    text = dispatch.render(template, {**variables, 'card_id': args.card}).encode()
    for folder in (args.tmp_dir, args.brief_dir):
        if read(folder / ('brief-' + args.card + '.md')) != text:
            raise ValueError('brief readback mismatch')
    if args.registration_file:
        registration = json.loads(read(args.registration_file))
    else:
        result = subprocess.run([str(args.carr_root / 'run.sh'), 'call', 'job-card-registration',
                                 json.dumps({'card_id': args.card})], capture_output=True, timeout=30)
        if result.returncode or len(result.stdout) > LIMIT:
            raise ValueError('registration read failed')
        registration = json.loads(result.stdout)
    card = request['card']
    expected = {'ok': True, 'registered': True, 'card_id': args.card,
                'repository': card['repository'], 'executor': card['executor'], 'model': card['model']}
    if any(type(registration.get(k)) is not type(v) or registration.get(k) != v for k, v in expected.items()):
        raise ValueError('registered card mismatch')
    return {'ok': True, 'mode': 'fixture' if args.registration_file else 'live-read-only',
            'card_id': args.card, 'installed_identity': 'matches trusted proof checkout', 'brief_readbacks': 2}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request', type=Path)
    parser.add_argument('--card', required=True)
    parser.add_argument('--installed-root', type=Path, required=True)
    parser.add_argument('--tmp-dir', type=Path, default=Path('/tmp'))
    parser.add_argument('--brief-dir', type=Path, default=Path.home() / '.claude/orchestrate/doctorcre-delivery/briefs')
    parser.add_argument('--carr-root', type=Path, default=Path.home() / 'carr-system')
    parser.add_argument('--registration-file', type=Path, help='offline control only; output is labeled fixture')
    args = parser.parse_args()
    try:
        print(json.dumps(prove(args)))
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print('proof refused: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
