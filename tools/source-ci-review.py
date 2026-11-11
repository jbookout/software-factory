#!/usr/bin/env python3
"""Consume one candidate on a trusted host, or verify a bound receipt offline."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from lib.source_ci_review import Consumer, prove


def read(path):
    with Path(path).open('rb') as source:
        data = source.read(65537)
    if len(data) > 65536:
        raise ValueError('input exceeds 64 KiB')
    return json.loads(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    consume = commands.add_parser('consume')
    consume.add_argument('--candidate', required=True)
    consume.add_argument('--store', required=True)
    consume.add_argument('--host-module', required=True, type=Path)
    receipt = commands.add_parser('receipt')
    receipt.add_argument('--store', required=True, type=Path)
    receipt.add_argument('--key', required=True)
    proof = commands.add_parser('prove')
    proof.add_argument('--candidate', required=True)
    proof.add_argument('--receipt', required=True)
    proof.add_argument('--revision', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'prove':
            accepted = prove(read(args.receipt), read(args.candidate), args.revision)
            print(json.dumps({'receipt_bindings_verified': accepted, 'remote_execution_verified': False}))
            return 0 if accepted else 1
        if args.command == 'receipt':
            import sqlite3
            with sqlite3.connect(args.store.resolve().as_uri() + '?mode=ro', uri=True) as db:
                row = db.execute('SELECT receipt FROM reviews WHERE request_key=?', (args.key,)).fetchone()
            print(row[0] if row else 'null')
            return 0 if row else 1
        revision = subprocess.check_output(
            ['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True, timeout=5).strip()
        for path in ('lib/source_ci_review.py', 'tools/source-ci-review.py'):
            committed = subprocess.check_output(
                ['git', '-C', str(ROOT), 'show', f'{revision}:{path}'], timeout=5,
                stderr=subprocess.PIPE)
            if committed != (ROOT / path).read_bytes():
                raise ValueError('consumer source differs from pinned revision')
        artifact = read(args.candidate)
        spec = importlib.util.spec_from_file_location('trusted_review_host', args.host_module.resolve())
        if spec is None or spec.loader is None:
            raise ValueError('invalid host module')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with Consumer(args.store, revision) as consumer:
            result = consumer.consume(artifact, module.host)
        print(json.dumps(result, sort_keys=True))
        return 0 if result['state'] == 'launched' else 1
    except Exception as error:
        print(json.dumps({'state': 'error', 'reason': type(error).__name__}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
