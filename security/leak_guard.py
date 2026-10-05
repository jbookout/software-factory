#!/usr/bin/env python3
"""Repository-local leak gate. Diagnostics contain locations, never values."""
import argparse
import bisect
import html
from collections import Counter
import hashlib
import io
import json
import os
import pathlib
import platform
import re
import subprocess
import sys
import tarfile
import urllib.request
import uuid
import unicodedata

HERE = pathlib.Path(__file__).resolve().parent
VERSION = '8.30.0'
ARCHIVES = {
    'darwin_arm64': 'b251ab2bcd4cd8ba9e56ff37698c033ebf38582b477d21ebd86586d927cf87e7',
    'darwin_x64': 'ca221d012d247080c2f6f61f4b7a83bffa2453806b0c195c795bbe9a8c775ed5',
    'linux_x64': '79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e',
    'linux_arm64': 'b4cbbb6ddf7d1b2a603088cd03a4e3f7ce48ee7fd449b51f7de6ee2906f5fa2f',
}
PII = {
    'pii-email': re.compile(r'(?<![A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-])[A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+'),
    'pii-phone': re.compile(r'(?<![\w])(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[ .-]?[2-9]\d{2}[ .-]?\d{4}(?![\w])'),
    'pii-address': re.compile(r'\b\d{1,6}\s+(?:[A-Za-z0-9.-]+\s+){1,6}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Court|Ct|Way|Place|Pl|Parkway|Pkwy)\b', re.I),
    'pii-ssn': re.compile(r'(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)'),
}


def tokens(text):
    if not text.isascii():
        text = unicodedata.normalize('NFKD', text)
        text = ''.join(c for c in text if not unicodedata.combining(c))
    return re.findall(r'[a-z0-9]+', text.lower())


def decode_source(text):
    text = re.sub(r'\\(\\|u[0-9a-fA-F]{4}|[nrtbf])',
                  lambda m: '\\' if m[1] == '\\' else chr(int(m[1][1:], 16)) if m[1].startswith('u') else ' ', text)
    return html.unescape(text)


def validate_corpus(corpus):
    if (corpus.get('schema') != 'leak-guard-corpus.v1'
        or not re.fullmatch(r'[0-9a-f]{64}', corpus.get('salt', ''))
        or not corpus.get('hashes') or not corpus.get('lengths')
        or any(type(n) is not int or not 1 <= n <= 64 for n in corpus['lengths'])
        or any(not re.fullmatch(r'[0-9a-f]{64}', h) for h in corpus['hashes'])):
        raise ValueError('invalid corpus')
    if 'starts' in corpus and (not isinstance(corpus['starts'], list) or not corpus['starts']
                              or any(not re.fullmatch(r'[0-9a-f]{64}', h) for h in corpus['starts'])):
        raise ValueError('invalid corpus starts')
    if 'start_lengths' in corpus and (not isinstance(corpus['start_lengths'], dict)
        or set(corpus['start_lengths']) != set(corpus.get('starts', []))
        or any(not sizes or any(type(n) is not int or n not in corpus['lengths'] for n in sizes)
               for sizes in corpus['start_lengths'].values())):
        raise ValueError('invalid corpus length index')
    return corpus


def make_corpus(values, salt):
    hashes, lengths, starts, start_lengths = set(), set(), set(), {}
    for value in values:
        normalized = tokens(str(value))
        if not normalized:
            continue
        if len(normalized) > 64:
            raise ValueError('export value exceeds window')
        lengths.add(len(normalized))
        hashes.add(hashlib.sha256((salt + '\0' + ''.join(normalized)).encode()).hexdigest())
        first = hashlib.sha256((salt + '\0' + normalized[0]).encode()).hexdigest()
        starts.add(first)
        start_lengths.setdefault(first, set()).add(len(normalized))
    return validate_corpus({'schema': 'leak-guard-corpus.v1', 'salt': salt,
                            'lengths': sorted(lengths), 'hashes': sorted(hashes), 'starts': sorted(starts),
                            'start_lengths': {h: sorted(ns) for h, ns in sorted(start_lengths.items())}})


def pii_findings(text, corpus):
    words, numbers = [], []
    for number, line in enumerate(text.split('\n'), 1):
        line = decode_source(line)
        for rule, regex in PII.items():
            if regex.search(line):
                yield number, rule, ''
        normalized = tokens(line)
        words.extend(normalized)
        numbers.extend([number] * len(normalized))
    if corpus:
        hashes = corpus.get('_hashes') or set(corpus['hashes'])
        prefix = corpus.get('_prefix') or hashlib.sha256((corpus['salt'] + '\0').encode())
        lengths = corpus.get('_lengths') or set(corpus['lengths'])
        starts = corpus.get('_starts')
        first_cache = corpus.get('_first_cache', {})
        window_cache = corpus.get('_window_cache', {})
        for start in range(len(words)):
            word = words[start]
            if word not in first_cache:
                first_digest = prefix.copy()
                first_digest.update(word.encode())
                first = first_digest.hexdigest()
                first_cache[word] = first if starts is None or first in starts else None
            first = first_cache[word]
            if first is None:
                continue
            candidates = corpus.get('_start_lengths', {}).get(first, lengths)
            longest = max(candidates)
            window = tuple(words[start:start + longest])
            if window in window_cache:
                for fingerprint in window_cache[window]:
                    yield numbers[start], 'client-data', fingerprint
                continue
            digest = prefix.copy()
            digest.update(word.encode())
            found = []
            if 1 in candidates and first in hashes:
                found.append(first)
                yield numbers[start], 'client-data', first
            for end in range(start + 1, min(len(words), start + longest)):
                digest.update(words[end].encode())
                if end - start + 1 in candidates and digest.copy().hexdigest() in hashes:
                    found.append(digest.hexdigest())
                    yield numbers[start], 'client-data', digest.hexdigest()
            if len(window_cache) >= 100000:
                window_cache.clear()
            window_cache[window] = found


def gitleaks():
    arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'AMD64': 'x64'}[platform.machine()]
    target = platform.system().lower() + '_' + arch
    checksum = ARCHIVES[target]
    cache = pathlib.Path.home() / '.cache' / 'leak-guard' / VERSION / target
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    archive = cache / 'release.tar.gz'
    if not archive.exists():
        url = f'https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/gitleaks_{VERSION}_{target}.tar.gz'
        data = urllib.request.urlopen(url, timeout=60).read()
        if hashlib.sha256(data).hexdigest() != checksum:
            raise ValueError('release checksum mismatch')
        archive.write_bytes(data)
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != checksum:
        raise ValueError('cached release checksum mismatch')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as bundle:
        binary = bundle.extractfile('gitleaks').read()
    executable = cache / 'gitleaks'
    if not executable.exists() or executable.read_bytes() != binary:
        executable.write_bytes(binary)
        executable.chmod(0o700)
    return executable


def git(root, *args):
    return subprocess.run(['git', '--no-replace-objects', '-C', str(root), *args], check=True, capture_output=True).stdout


def staged(root):
    changed = set(git(root, 'diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z').split(b'\0'))
    entries = git(root, 'ls-files', '--stage', '-z').split(b'\0')
    for entry in entries:
        if not entry:
            continue
        meta, path = entry.split(b'\t', 1)
        if path not in changed:
            continue
        mode, oid, stage = meta.split()
        if stage != b'0':
            raise ValueError('unmerged index')
        if mode == b'160000':
            continue
        yield path.decode('utf-8', 'surrogateescape'), git(root, 'cat-file', 'blob', oid.decode())


def history(root, revisions):
    if git(root, 'rev-parse', '--is-shallow-repository').strip() != b'false':
        raise ValueError('shallow history')
    changes = git(root, 'log', '--format=', '--raw', '-z', '--no-abbrev', '--no-renames',
                  '--root', '-m', *revisions, '--').split(b'\0')
    objects = {}
    index = 0
    while index < len(changes):
        header = changes[index].lstrip(b'\n')
        index += 1
        if not header:
            continue
        if not header.startswith(b':') or index >= len(changes):
            raise ValueError('invalid raw history')
        fields = header.split()
        if len(fields) != 5:
            raise ValueError('invalid raw history')
        path = changes[index].decode('utf-8', 'surrogateescape')
        index += 1
        if fields[1] in (b'000000', b'160000'):
            continue
        objects.setdefault(fields[3], set()).add(path)
    child = subprocess.Popen(['git', '--no-replace-objects', '-C', str(root), 'cat-file', '--batch'],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        for oid, paths in objects.items():
            child.stdin.write(oid + b'\n')
            child.stdin.flush()
            header = child.stdout.readline().split()
            if len(header) != 3 or header[0] != oid or header[1] != b'blob':
                raise ValueError('unreadable blob')
            raw = child.stdout.read(int(header[2]))
            if len(raw) != int(header[2]) or child.stdout.read(1) != b'\n':
                raise ValueError('truncated blob')
            for path in sorted(paths):
                yield path, raw
    finally:
        child.stdin.close()
        child.stdout.close()
        if child.wait() != 0:
            raise ValueError('git object reader failed')


def pushed(root, stream, remote_name):
    revisions = []
    zero = '0' * 40
    for line in stream.splitlines():
        fields = line.split()
        if len(fields) != 4 or not all(re.fullmatch(r'[0-9a-f]{40}', fields[i]) for i in (1, 3)):
            raise ValueError('invalid push refs')
        _, local, _, remote = fields
        if local == zero:
            continue
        git(root, 'rev-parse', '--verify', local + '^{commit}')
        # New refs scan their complete ancestry, including every intermediate commit.
        # Existing refs exclude only ancestry Git says the receiver already has.
        revisions.append(local)
        if remote != zero:
            git(root, 'rev-parse', '--verify', remote + '^{commit}')
            revisions.append('^' + remote)
        elif re.fullmatch(r'[A-Za-z0-9._-]+', remote_name):
            known = git(root, 'for-each-ref', '--format=%(objectname)', 'refs/remotes/' + remote_name)
            revisions.extend('^' + oid for oid in known.decode().splitlines())
    return history(root, revisions) if revisions else iter(())


def load_allowlist(path):
    if not path.exists():
        return set()
    data = json.loads(path.read_text())
    if data.get('schema') != 'leak-guard-allowlist.v1' or not isinstance(data.get('entries'), list):
        raise ValueError('invalid allowlist')
    entries = set()
    for entry in data['entries']:
        if (set(entry) not in ({'path', 'sha256', 'rule', 'reason'}, {'path', 'sha256', 'rule', 'reason', 'value_sha256'})
            or not all(isinstance(entry[k], str) and entry[k].strip() for k in entry)
            or not re.fullmatch(r'[0-9a-f]{64}', entry['sha256'])
            or (entry['rule'] == 'client-data' and not re.fullmatch(r'[0-9a-f]{64}', entry.get('value_sha256', '')))
            or '*' in entry['path']
            or pathlib.PurePosixPath(entry['path']).is_absolute() or '..' in pathlib.PurePosixPath(entry['path']).parts):
            raise ValueError('invalid allowlist entry')
        entries.add((entry['path'], entry['sha256'], entry['rule'], entry.get('value_sha256', '')))
    return entries


def scan(root, source, corpus, allowed, report_path=None):
    private = root / 'out' / '_to_delete' / 'leak-guard' / str(uuid.uuid4())
    private.mkdir(parents=True, mode=0o700)
    template = private / 'report.tmpl'
    template.write_text(r'{{range .}}{{printf "{\"line\":%d,\"rule\":%q}\n" .StartLine .RuleID}}{{end}}')
    report = private / 'locations.jsonl'
    command = [str(gitleaks()), 'stdin', '--redact=100', '--no-banner', '--no-color',
               '--ignore-gitleaks-allow', '--report-format=template', '--report-template', str(template),
               '--report-path', str(report)]
    env = {k: v for k, v in os.environ.items() if not k.startswith('GITLEAKS_')}
    findings, sensitive_paths, pii_cache = set(), set(), {}
    if corpus:
        corpus = {**corpus, '_hashes': set(corpus['hashes']), '_lengths': set(corpus['lengths']),
                  '_prefix': hashlib.sha256((corpus['salt'] + '\0').encode()),
                  '_starts': set(corpus['starts']) if 'starts' in corpus else None,
                  '_start_lengths': {h: set(ns) for h, ns in corpus.get('start_lengths', {}).items()},
                  '_first_cache': {}, '_window_cache': {}}
    chunks, locations, starts, digests, hits = [], [], [], [], []
    line, batch_bytes = 1, 0

    def flush():
        if not chunks:
            return
        report.write_text('')
        result = subprocess.run(command, input=b''.join(chunks), capture_output=True, cwd=private, env=env)
        if result.returncode not in (0, 1):
            raise ValueError('gitleaks failed')
        secret_count = 0
        for row in report.read_text().splitlines():
            hit = json.loads(row)
            index = bisect.bisect_right(starts, hit['line']) - 1
            if index < 0 or hit['line'] >= line:
                raise ValueError('invalid secret location')
            offset = hit['line'] - starts[index]
            if offset == 0:
                sensitive_paths.add(locations[index])
            hits.append((index, max(1, offset), hit['rule'], ''))
            secret_count += 1
        if (result.returncode == 1) != bool(secret_count):
            raise ValueError('gitleaks verdict/report disagreement')
        findings.update((locations[i], number, rule) for i, number, rule, fingerprint in hits
                        if (locations[i], digests[i], rule, fingerprint) not in allowed)
        chunks.clear()
        locations.clear()
        starts.clear()
        digests.clear()
        hits.clear()

    for path, raw in source:
        digest = hashlib.sha256(raw).hexdigest()
        utf16 = raw.startswith((b"\xff\xfe", b"\xfe\xff"))
        opaque = (b'\0' in raw and not utf16) or raw.startswith((b'%PDF-', b'PK\x03\x04', b'\x1f\x8b'))
        # Uninspectable binary content is refused as a whole, never silently skipped.
        text = '' if opaque else raw.decode('utf-16' if utf16 else 'utf-8', errors='replace')
        secret_input = path.encode('utf-8', 'surrogateescape') + b'\n' + text.encode('utf-8') + b'\n'
        if chunks and batch_bytes + len(secret_input) > 8 * 1048576:
            flush()
            line, batch_bytes = 1, 0
        index = len(locations)
        starts.append(line)
        locations.append(path)
        digests.append(digest)
        if opaque:
            hits.append((index, 1, 'opaque-binary', ''))
        else:
            if digest not in pii_cache:
                pii_cache[digest] = list(pii_findings(text, corpus))
            hits.extend((index, number, rule, fingerprint) for number, rule, fingerprint in pii_cache[digest])
        hits.extend((index, 1, rule, fingerprint) for _, rule, fingerprint in pii_findings(path, corpus))
        chunks.append(secret_input)
        line += secret_input.count(b'\n')
        batch_bytes += len(secret_input)
    flush()
    findings = sorted(findings)
    if report_path:
        relative = report_path.resolve().relative_to(root.resolve() / 'out')
        if not relative.parts:
            raise ValueError('report must be under ignored out')
        git(root, 'check-ignore', str(report_path))
        if git(root, 'ls-files', '--', str(report_path)).strip():
            raise ValueError('tracked report')
        report_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        report_path.write_text(json.dumps({'schema': 'leak-guard-private-report.v1',
                              'counts': dict(Counter(rule for _, _, rule in findings)),
                              'files': dict(sorted(Counter(path for path, _, _ in findings).items()))}, indent=2) + '\n')
        report_path.chmod(0o600)
    else:
        for path, number, rule in findings:
            name = '[redacted-path:' + hashlib.sha256(path.encode('utf-8', 'surrogateescape')).hexdigest()[:12] + ']'
            if path not in sensitive_paths and not list(pii_findings(path, corpus)):
                name = json.dumps(path, ensure_ascii=True)[1:-1]
            print(f'{name}:{number} {rule}')
    return int(bool(findings))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=pathlib.Path, default=HERE.parent)
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument('--staged', action='store_true')
    scope.add_argument('--history', action='store_true')
    scope.add_argument('--range')
    scope.add_argument('--pre-push', action='store_true')
    scope.add_argument('--ci', action='store_true')
    parser.add_argument('--generic-only', action='store_true')
    parser.add_argument('--corpus', type=pathlib.Path, default=HERE / 'client-hashes.json')
    parser.add_argument('--allowlist', type=pathlib.Path, default=HERE / 'allowlist.json')
    parser.add_argument('--report', type=pathlib.Path)
    parser.add_argument('--remote', default='origin')
    args = parser.parse_args()
    corpus = None if args.generic_only else validate_corpus(json.loads(args.corpus.read_text()))
    allowed = load_allowlist(args.allowlist)
    if args.pre_push:
        source = pushed(args.root, sys.stdin.read(), args.remote)
    elif args.history:
        source = history(args.root, ['--all'])
    elif args.range:
        if not re.fullmatch(r'[0-9a-f]{40}\.\.[0-9a-f]{40}', args.range):
            raise ValueError('range must bind full commit hashes')
        source = history(args.root, [args.range])
    elif args.ci:
        if os.environ.get('GITHUB_EVENT_NAME') != 'pull_request':
            raise ValueError('CI scope requires a pull request event')
        event = json.loads(pathlib.Path(os.environ['GITHUB_EVENT_PATH']).read_text())
        base, head = (event['pull_request'][k]['sha'] for k in ('base', 'head'))
        if not all(re.fullmatch(r'[0-9a-f]{40}', oid) for oid in (base, head)):
            raise ValueError('invalid pull request commits')
        source = history(args.root, [base + '..' + head])
    else:
        source = staged(args.root)
    return scan(args.root, source, corpus, allowed, args.report)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('leak-guard: scan could not complete; push/CI refused', file=sys.stderr)
        sys.exit(2)
