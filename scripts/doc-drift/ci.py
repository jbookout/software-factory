#!/usr/bin/env python3
"""Run instruction-checker fixtures and emit warnings through the same local/CI path."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def verify_snapshot(root):
    manifest = root / 'scripts/doc-drift/source.json'
    if not manifest.exists():
        return
    pin = json.loads(manifest.read_text())
    if pin['repository'] != 'jbookout/software-factory' or len(pin['revision']) != 40 or not pin['files']:
        raise ValueError('invalid instruction checker source pin')
    for file, expected in pin['files'].items():
        path = (root / file).resolve()
        if not path.is_relative_to(root) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f'instruction checker snapshot changed: {file}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    verify_snapshot(root)
    subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'test/doc_drift', '-v'], cwd=root, check=True)
    command = [sys.executable, str(root / 'scripts/doc-drift/check.py'), '--root', str(root),
               '--format', 'github', '--output', str(root / 'out/doc-drift/report.json')]
    if args.base:
        command += ['--base', args.base]
    subprocess.run(command, cwd=root, check=True)


if __name__ == '__main__':
    main()
