#!/usr/bin/env python3
"""Read private values on stdin and emit only a normalized salted hash corpus."""
import json
import secrets
import sys
from leak_guard import make_corpus


def main():
    data = json.load(sys.stdin)
    if set(data) != {'values'} or not isinstance(data['values'], list) or not data['values']:
        raise ValueError('invalid export')
    if any(not isinstance(v, str) for v in data['values']):
        raise ValueError('invalid export')
    print(json.dumps(make_corpus(data['values'], secrets.token_hex(32)), indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('leak-guard: hash export failed; no corpus emitted', file=sys.stderr)
        sys.exit(2)
