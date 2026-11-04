#!/usr/bin/env python3
"""Fixture executable. Does not install hooks or attest native recovery."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.session_continuity import MAX_INPUT, Store, process


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store', required=True)
    parser.add_argument('--recover', action='store_true')
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise ValueError('input_too_large')
        envelope = json.loads(raw)
        if not isinstance(envelope, dict):
            raise ValueError('invalid_envelope')
        store = Store(args.store)
        result = store.recover(envelope['binding']) if args.recover else process(envelope, store)
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        result = {'status': 'degraded', 'reason': 'invalid_input_or_store_unavailable'}
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
