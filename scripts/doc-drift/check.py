#!/usr/bin/env python3
"""Static instruction claims and warning-only reports. Never runs doc commands."""
import argparse
import difflib
import fnmatch
import json
from pathlib import Path
import plistlib
import re
import subprocess
import sys
from urllib.parse import unquote, urlparse

import yaml

SCHEMA = 'doc-drift/v1'
PATH = re.compile(r'(?<![\w/:])(?:\./|\.\./|~/|/)?(?:[\w.@*<>${}-]+/)+[\w.@*<>${}-]*(?:/)?')
LINK = re.compile(r'\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\)')
CODE = re.compile(r'`([^`\n]+)`')
TOOL = re.compile(r'''["']([a-z][a-z0-9-]+)["']\s*:\s*\{\s*(?:write\s*:\s*(?:true|false)\s*,\s*)?description\s*:''')
IMPORT = re.compile(r'''(?:from\s*|import\s*)["'](\.[^"']+)["']''')


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True, stderr=subprocess.PIPE, timeout=30)


def document(file):
    return Path(file).suffix.lower() in {'.md', '.mdx', '.rst'}


def flatten(value, prefix=''):
    keys = set()
    if isinstance(value, dict):
        for key, child in value.items():
            name = f'{prefix}.{key}' if prefix else str(key)
            keys.add(name)
            keys.update(flatten(child, name))
    return keys


class Tree:
    def __init__(self, root):
        self.root = root
        self.files = set(filter(None, git(root, 'ls-files', '-z').split('\0')))
        self.roots = {f.split('/')[0] for f in self.files if '/' in f}
        try:
            remote = git(root, 'remote', 'get-url', 'origin').strip()
            self.repo = re.search(r'github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$', remote)[1]
        except (subprocess.SubprocessError, TypeError):
            self.repo = None
        self.verbs = set()
        self.verb_sources = set()
        self.workflows = {}
        self.jobs = {}
        self.configs = {}
        self.renames = None
        self.load_verbs('mcp-server/src/tools.js')
        for file in sorted(self.files):
            if file.startswith('.github/workflows/') and file.endswith(('.yml', '.yaml')):
                data = self.config(file)
                if not isinstance(data, dict):
                    raise ValueError(f'invalid workflow mapping: {file}')
                self.workflows[file] = str(data.get('name', Path(file).stem))
                self.jobs[file] = set(data.get('jobs', {}))
            elif file.endswith('.plist'):
                data = plistlib.loads((root / file).read_bytes())
                if isinstance(data, dict) and isinstance(data.get('Label'), str):
                    self.jobs[file] = {data['Label']}
        self.commands = set()
        if 'run.sh' in self.files:
            for match in re.finditer(r'^\s*([a-z][\w| -]*)\)\s*', (root / 'run.sh').read_text(), re.M):
                self.commands.update(x.strip() for x in match[1].split('|') if x.strip())

    def load_verbs(self, file):
        if file in self.verb_sources or file not in self.files:
            return
        self.verb_sources.add(file)
        source = (self.root / file).read_text()
        self.verbs.update(TOOL.findall(source))
        for relative in IMPORT.findall(source):
            path = (self.root / file).parent / relative
            self.load_verbs(path.resolve().relative_to(self.root).as_posix())

    def config(self, file):
        if file not in self.configs:
            text = (self.root / file).read_text()
            suffix = Path(file).suffix
            if suffix == '.json':
                data = json.loads(text)
            elif suffix in {'.yml', '.yaml'}:
                data = yaml.safe_load(text)
            elif suffix == '.toml':
                import tomllib
                data = tomllib.loads(text)
            else:
                raise ValueError(f'unsupported config: {file}')
            self.configs[file] = data
        return self.configs[file]

    def path(self, raw, file, relative=False):
        parsed = urlparse(raw)
        blob = re.fullmatch(r'/([^/]+/[^/]+)/(?:blob|tree)/(main|HEAD)/(.+)', parsed.path)
        if parsed.hostname == 'github.com' and blob and blob[1] == self.repo:
            raw = blob[3]
            parsed = urlparse(raw)
            relative = False
        if parsed.scheme or raw.startswith(('//', '~', '/')):
            return raw, 'external or machine-local reference'
        raw = unquote(parsed.path).rstrip('.')
        raw = re.sub(r':\d+(?:[-:]\d+)?$', '', raw).rstrip('/')
        if not raw:
            return raw, 'same-document anchor'
        if re.search(r'[<>${}]', raw) or raw.startswith(('path/to/', 'foo/', 'example/')):
            return raw, 'parameterized example'
        if raw in {'DNA', '00_Context'} or raw.startswith(('DNA/', '00_Context/')):
            return raw, 'STORE/vault reference outside repository'
        if 'CARR AI/' in raw or raw.startswith(('My Drive/', 'Automation/', 'Marketing/', '_to_delete/', 'origin/')):
            return raw, 'vault, quarantine, or git reference outside source tree'
        if raw.startswith('@'):
            return raw, 'package name, not a repository file'
        if raw.startswith('jbookout/'):
            return raw, 'cross-repository name'
        if raw.startswith(('github.com/', 'node_modules/', 'dist/', 'out/', '.venv/', '.claude/')) or '/.qualification' in raw or '/.venv' in raw:
            return raw, 'external source or generated artifact'
        package = self.root / 'package.json'
        if package.exists():
            data = self.config('package.json')
            name = data.get('name', '')
            if raw.startswith(name + '/') and './' + raw[len(name) + 1:] in data.get('exports', {}):
                return raw, 'package export, not a repository path'
        choices = [self.root / raw]
        choices.extend(parent / raw for parent in (self.root / file).parents if parent.is_relative_to(self.root))
        if relative:
            choices.reverse()
        for choice in choices:
            resolved = choice.resolve()
            if not resolved.is_relative_to(self.root):
                continue
            target = resolved.relative_to(self.root).as_posix()
            if choice.exists() or any(fnmatch.fnmatch(f, target) for f in self.files):
                return target, None
        first = choices[0].resolve()
        if not first.is_relative_to(self.root):
            return raw, 'reference outside repository'
        return first.relative_to(self.root).as_posix(), None

    def suggestion(self, target, candidates):
        if self.renames is None:
            self.renames = {}
            history = git(self.root, 'log', '--all', '--format=', '--name-status', '--diff-filter=R', '--find-renames')
            for line in history.splitlines():
                parts = line.split('\t')
                if len(parts) == 3 and parts[0].startswith('R'):
                    self.renames.setdefault(parts[1], parts[2])
        renamed, visited = target, set()
        while renamed in self.renames and renamed not in visited:
            visited.add(renamed)
            renamed = self.renames[renamed]
        if renamed != target and renamed in self.files:
            history = git(self.root, 'log', '-1', '--follow', '--format=%h %s', '--', renamed).strip()
            return renamed, f'git rename history; git log --follow: {history}'
        matches = difflib.get_close_matches(target, sorted(candidates), n=1, cutoff=0.78)
        return (matches[0], 'name similarity, unverified') if matches else (None, None)


def extract(tree, file, text):
    claims = []
    seen = set()

    def add(line, kind, target, sources=(), unchecked=None):
        key = (line, kind, target, tuple(sources))
        if key not in seen:
            seen.add(key)
            claims.append(dict(file=file, line=line, kind=kind, target=target,
                               sources=list(sources), unchecked=unchecked))

    paragraph_context = None
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.startswith('#'):
            paragraph_context = None
        clean = line
        for match in LINK.finditer(line):
            target, reason = tree.path(match[1], file, relative=True)
            add(number, 'path', target, [target], reason)
            clean = clean.replace(match[0], ' ' * len(match[0]))
        clean = re.sub(r'(?:https?://|app://|file://|plugin://)[^\s`)>]+', '', clean)
        context = paragraph_context
        if re.search(r'do not create|must not (?:create|use)|has no|does not (?:have|contain)|never create', line, re.I):
            context = 'negative instruction, not an existence claim'
        elif re.search(r'\bplanned\b|\bproposed\b|not started|future (?:file|path|work)|old script', line, re.I):
            context = 'planned or historical reference'
        paragraph_context = context
        path_text = clean
        for code in CODE.findall(clean):
            if (re.fullmatch(r'(?:\./|\.\./|~/)?[\w .@*<>${}-]+(?:/[\w .@*<>${}-]+)+/?', code)
                    and not re.match(r'(?:python3?|node|npm|bash|sh|git|gh|env)\s', code)
                    and (code.split('/')[0] in tree.roots or code.startswith(('./', '../', '~/', 'DNA/', '00_Context/', '@'))
                         or re.search(r'\.(?:py|sh|js|mjs|ts|tsx|json|ya?ml|toml|md|mdx|rst|html|css|sql)$', code))
                    and (not ' ' in code or re.search(r'\.[\w]+$', code) or code.endswith('/'))):
                path, reason = tree.path(code, file)
                if 'github.com/' in line and code.startswith('skills/'):
                    reason = 'path in the cited upstream repository'
                add(number, 'path', path, [path], reason or context)
                path_text = path_text.replace('`' + code + '`', '')
        for target in PATH.findall(path_text):
            if not (target.startswith(('./', '../', '~/', '/')) or target.split('/')[0] in tree.roots
                    or re.search(r'\.(?:py|sh|js|mjs|ts|tsx|json|ya?ml|toml|md|mdx|rst|html|css|sql)\.?$', target)):
                continue
            path, reason = tree.path(target, file)
            reason = reason or context
            if 'github.com/' in line and target.startswith('skills/'):
                reason = 'path in the cited upstream repository'
            if re.search(r'if (?:it |they )?exist|if present|optional|generated|produced', line, re.I) and not (tree.root / path).exists():
                reason = reason or 'conditional or generated reference'
            add(number, 'path', path, [path], reason)
        codes = CODE.findall(clean)
        for code in codes:
            if re.fullmatch(r'[\w.-]+\.(?:py|sh|js|mjs|ts|json|ya?ml|toml|md|mdx|rst)', code):
                target, reason = tree.path(code, file)
                add(number, 'path', target, [target], reason or context)
        for match in re.finditer(r'(?:python3?|node|bash|sh)\s+([\w.-]+\.(?:py|sh|js|mjs))', clean):
            target, reason = tree.path(match[1], file)
            add(number, 'path', target, [target], reason or context)
        for match in re.finditer(r'(?:\./)?run\.sh\s+(?:call\s+([a-z][\w-]*)|([a-z][\w-]*))', clean):
            if match[1]:
                add(number, 'verb', match[1], sorted(tree.verb_sources) or ['mcp-server/src/tools.js'])
            else:
                if match[2] not in {'is', 'was', 'and', 'or', 'does', 'will', 'has'}:
                    add(number, 'command', match[2], ['run.sh'])
        for match in re.finditer(r'(?:verb\s+`([a-z][\w-]*)`|`([a-z][\w-]*)`\s+verb)', clean, re.I):
            add(number, 'verb', match[1] or match[2], sorted(tree.verb_sources) or ['mcp-server/src/tools.js'])
        for match in re.finditer(r'npm\s+(?:--prefix\s+([\w./-]+)\s+)?run\s+([\w:-]+)', clean):
            package = f"{match[1].rstrip('/')}/package.json" if match[1] else 'package.json'
            if not match[1]:
                local = (Path(file).parent / 'package.json').as_posix()
                if local in tree.files:
                    package = local
            add(number, 'npm-script', match[2], [package])
        workflow_claims = []
        for match in re.finditer(r'workflow\s+`([^`]+)`', clean, re.I):
            target = match[1]
            sources = [f for f, name in tree.workflows.items() if target in {f, name, Path(f).name, Path(f).stem}]
            add(number, 'workflow', target, sources or sorted(tree.workflows))
            workflow_claims.extend(sources)
        for match in re.finditer(r'job\s+`([^`]+)`', clean, re.I):
            add(number, 'job', match[1], workflow_claims or sorted(tree.jobs))
        config_paths = [c['target'] for c in claims if c['line'] == number and c['kind'] == 'path'
                        and c['target'].endswith(('.json', '.yaml', '.yml', '.toml')) and not c['unchecked']]
        for config in config_paths:
            for match in re.finditer(r'(?:\b(?:key|field|option)\s+|\bset\s+)`([\w.-]+)`', clean, re.I):
                add(number, 'config-key', match[1], [config], context)
        for match in re.finditer(r'`([^`]+\.(?:json|ya?ml|toml))#([\w.-]+)`', clean):
            target, reason = tree.path(match[1], file)
            add(number, 'config-key', match[2], [target], reason)
    return claims


def check(tree, claim):
    kind, target, sources = claim['kind'], claim['target'], claim['sources']
    if claim['unchecked']:
        return None
    if kind == 'path':
        good = (tree.root / target).exists() or any(fnmatch.fnmatch(f, target) for f in tree.files)
        candidates = tree.files
    elif kind == 'verb':
        if 'mcp-server/src/tools.js' not in tree.files:
            claim['unchecked'] = 'verb authority not in this repository'
            return None
        good, candidates = target in tree.verbs, tree.verbs
    elif kind == 'command':
        if 'run.sh' not in tree.files:
            claim['unchecked'] = 'command authority not in this repository'
            return None
        good, candidates = target in tree.commands, tree.commands
    elif kind == 'npm-script':
        candidates = tree.config(sources[0]).get('scripts', {}) if sources[0] in tree.files else {}
        good = target in candidates
    elif kind == 'workflow':
        candidates = set(tree.workflows.values()) | set(tree.workflows) | {Path(f).stem for f in tree.workflows} | {Path(f).name for f in tree.workflows}
        good = target in candidates
    elif kind == 'job':
        candidates = set().union(*(tree.jobs.get(f, set()) for f in sources))
        good = target in candidates
    elif kind == 'config-key':
        candidates = flatten(tree.config(sources[0])) if sources[0] in tree.files else set()
        good = target in candidates
    else:
        raise ValueError(f'unknown claim: {kind}')
    if good:
        return None
    suggestion, evidence = tree.suggestion(target, candidates)
    return dict(claim, message=f'missing {kind}: {target}', suggestion=suggestion, suggestion_evidence=evidence)


def scan(root, base=None):
    tree = Tree(root)
    docs = sorted(f for f in tree.files if document(f))
    claims = [c for file in docs for c in extract(tree, file, (root / file).read_text())]
    selected = set(docs)
    if base:
        changed = set(filter(None, git(root, 'diff', '--name-only', '-z', f'{base}...HEAD').split('\0')))
        selected = changed.intersection(docs)
        base_docs = set(filter(None, git(root, 'ls-tree', '-r', '--name-only', '-z', base).split('\0')))
        prior = [c for file in docs if file in base_docs for c in extract(tree, file, git(root, 'show', f'{base}:{file}'))]
        for claim in claims + prior:
            if any(fnmatch.fnmatch(p, s) or p.startswith(s.rstrip('/') + '/')
                   for s in claim['sources'] for p in changed):
                selected.add(claim['file'])
        if any(f.startswith('.github/workflows/') for f in changed):
            selected.update(c['file'] for c in claims if c['kind'] in {'workflow', 'job'})
        if any(f.endswith('.plist') for f in changed):
            selected.update(c['file'] for c in claims if c['kind'] == 'job')
        if any(f.startswith('scripts/doc-drift/') for f in changed):
            selected = set(docs)
    claims = [c for c in claims if c['file'] in selected]
    findings = [f for c in claims if (f := check(tree, c))]
    return dict(schema=SCHEMA, owner='orchestrator', scope='pr' if base else 'full', source_sha=git(root, 'rev-parse', 'HEAD').strip(),
                files_checked=sorted(selected), claims=claims, findings=findings,
                unchecked=[c for c in claims if c['unchecked']])


def escape(value, property=False):
    value = str(value).replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
    return value.replace(':', '%3A').replace(',', '%2C') if property else value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--base', help='Select docs changed or referencing files changed since this git base')
    parser.add_argument('--format', choices=['json', 'text', 'github'], default='text')
    parser.add_argument('--output', type=Path, help='Write the complete JSON report')
    args = parser.parse_args()
    try:
        report = scan(args.root.resolve(), args.base)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + '\n')
        if args.format == 'json':
            print(json.dumps(report, indent=2))
        else:
            for f in report['findings']:
                message = f['message'] + (f"; likely {f['suggestion']} ({f['suggestion_evidence']})" if f['suggestion'] else '')
                message += '; owner: orchestrator; repair the instruction, rerun check.py; clears when claim resolves'
                if args.format == 'github':
                    print(f"::warning file={escape(f['file'], True)},line={f['line']}::{escape(message)}")
                else:
                    print(f"{f['file']}:{f['line']}: {message}")
            print(f"Checked {len(report['files_checked'])} instruction files, {len(report['claims'])} claims; {len(report['findings'])} stale, {len(report['unchecked'])} unchecked. Owner: orchestrator.")
    except (OSError, ValueError, yaml.YAMLError, plistlib.InvalidFileException, subprocess.SubprocessError) as error:
        print(f'doc-drift check failed: {type(error).__name__}; no clean verdict', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
