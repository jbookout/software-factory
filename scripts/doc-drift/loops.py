#!/usr/bin/env python3
"""Reconcile one GitHub issue loop per stale file, addressed to the orchestrator."""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


def marker(repo, file):
    digest = hashlib.sha256(f'{repo}:{file}'.encode()).hexdigest()
    return f'<!-- doc-drift/v1:{digest} -->'


def body(report, file, findings, tag):
    lines = [tag, 'Owner: orchestrator', '', f'Instruction file: `{file}`',
             f"Verified tree: `{report['source_sha']}`", '',
             'Repair these claims, then rerun the repository instruction checker.',
             'This loop clears when a full main scan finds no stale claim in the file.', '']
    for f in findings:
        suggestion = f"; candidate `{f['suggestion']}`" if f.get('suggestion') else ''
        lines.append(f"- Line {f['line']}: missing {f['kind']} `{f['target']}`{suggestion}.")
    return '\n'.join(lines) + '\n'


def publish(report, repo, forge):
    if (report.get('schema') != 'doc-drift/v1' or report.get('scope') != 'full'
            or report.get('owner') != 'orchestrator'
            or not re.fullmatch(r'[0-9a-f]{40}', report.get('source_sha', ''))
            or not re.fullmatch(r'[\w.-]+/[\w.-]+', repo)):
        raise ValueError('weekly reconciliation requires a complete versioned report')
    grouped = defaultdict(list)
    for finding in report['findings']:
        if finding['file'] not in report['files_checked']:
            raise ValueError('finding outside checked files')
        grouped[finding['file']].append(finding)
    existing = {}
    for issue in forge.list():
        if issue.get('pull_request'):
            continue
        match = re.search(r'<!-- doc-drift/v1:[0-9a-f]{64} -->', issue.get('body') or '')
        if match:
            if match[0] in existing:
                raise ValueError('duplicate existing loop markers; orchestrator must reconcile')
            existing[match[0]] = issue
    active = set()
    actions = []
    for file, findings in sorted(grouped.items()):
        tag = marker(repo, file)
        active.add(tag)
        content = body(report, file, findings, tag)
        issue = existing.get(tag)
        if not issue:
            forge.create(f'Instruction drift: {file}', content)
            actions.append(dict(action='create', file=file))
        elif issue['body'] != content or issue['state'].lower() != 'open':
            forge.update(issue['number'], content, 'open')
            actions.append(dict(action='update', file=file, number=issue['number']))
    for tag, issue in existing.items():
        if tag not in active and issue['state'].lower() == 'open':
            forge.update(issue['number'], issue['body'], 'closed')
            actions.append(dict(action='clear', number=issue['number']))
    return actions


class GitHub:
    def __init__(self, repo, apply):
        self.repo, self.apply = repo, apply

    def api(self, suffix, method='GET', payload=None):
        args = ['gh', 'api', f'repos/{self.repo}/{suffix}', '--method', method]
        if payload is not None:
            args += ['--input', '-']
        result = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                                text=True, capture_output=True, timeout=30, check=True)
        return json.loads(result.stdout)

    def list(self):
        issues, page = [], 1
        while True:
            batch = self.api(f'issues?state=all&per_page=100&page={page}')
            issues.extend(batch)
            if len(batch) < 100:
                return issues
            page += 1

    def create(self, title, body):
        if self.apply:
            self.api('issues', 'POST', dict(title=title, body=body))

    def update(self, number, body, state):
        if self.apply:
            self.api(f'issues/{number}', 'PATCH', dict(body=body, state=state))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--apply', action='store_true', help='Write issue loops; default is read-only plan')
    args = parser.parse_args()
    try:
        report = json.loads(args.report.read_text())
        actions = publish(report, args.repo, GitHub(args.repo, args.apply))
        print(json.dumps(dict(owner='orchestrator', applied=args.apply, actions=actions)))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f'doc-drift loop reconciliation failed: {type(error).__name__}; rerun only after reading current issues', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
