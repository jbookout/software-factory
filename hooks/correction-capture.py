#!/usr/bin/env python3
"""Disabled-by-default Stop/SessionEnd adapter. Supply only the current session."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.correction_capture import capture


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--enabled', action='store_true')
    parser.add_argument('--provider', choices=['claude', 'codex'])
    parser.add_argument('--session')
    parser.add_argument('--transcript', type=Path)
    parser.add_argument('--queue', type=Path)
    args = parser.parse_args()
    if not args.enabled:
        print(json.dumps({'enabled': False, 'captured': 0}))
        return
    if not all((args.provider, args.session, args.transcript, args.queue)):
        parser.error('enabled capture requires provider, session, transcript, and queue')
    print(json.dumps({'captured': capture(args.transcript, args.provider, args.session, args.queue)}))


if __name__ == '__main__':
    main()
