"""Read-only capability verification and immutable publication receipts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).parent
PROFILES = json.loads((ROOT / 'profiles.json').read_text())


def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=180).stdout.strip()


def require_version(tool, actual, expected):
    if actual != expected:
        raise ValueError(f'wrong {tool} version: expected {expected!r}, observed {actual!r}')


def check_tools(tools):
    for tool in tools:
        if not shutil.which(tool):
            raise ValueError(f'missing required tool: {tool}')


def verify(profile):
    contract = PROFILES[profile]
    if os.getuid() == 0:
        raise ValueError('qualification requires nonroot user')
    check_tools(contract['tools'])
    observed = {}
    for directory in (Path.home(), Path.cwd(), Path(os.environ.get('RUNNER_TEMP', '/tmp'))):
        with tempfile.TemporaryFile(dir=directory):
            pass
    if contract['node']:
        observed['node'] = command(['node', '--version'])
        require_version('node', observed['node'], contract['node'])
    if contract['playwright']:
        command(['node', str(ROOT / 'browsers.cjs'), contract['playwright']])
    if contract['postgres']:
        with tempfile.TemporaryDirectory(prefix='qualify-venv-') as directory:
            command(['python', '-m', 'venv', directory])
        observed['postgres_qualification'] = json.loads(command(['python', str(ROOT / 'qualify.py')]))
    if contract.get('pg_dump'):
        output = command(['/usr/lib/postgresql/18/bin/pg_dump', '--version'])
        if not re.match(r'pg_dump \(PostgreSQL\) 18\.', output):
            raise ValueError(f'wrong pg_dump version: {output}')
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / 'key'
            subprocess.run(['age-keygen', '-o', str(key)], check=True, capture_output=True, timeout=10)
            recipient = command(['age-keygen', '-y', str(key)])
            cipher = subprocess.run(['age', '-r', recipient], input=b'synthetic-backup', check=True, capture_output=True, timeout=10).stdout
            plain = subprocess.run(['age', '-d', '-i', str(key)], input=cipher, check=True, capture_output=True, timeout=10).stdout
            if plain != b'synthetic-backup':
                raise ValueError('age round trip failed')
    packages = command(['dpkg-query', '-W', '-f=${Package}\t${Version}\t${Architecture}\n'])
    return {'profile': profile, 'architecture': command(['uname', '-m']),
            'contract': contract, 'observed': observed, 'packages': [line.split('\t') for line in packages.splitlines()]}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def collect(profile, image, commit, directory):
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ci-qualification-') as temporary:
        cidfile = Path(temporary) / 'container.id'
        try:
            raw = command(['docker', 'run', '--rm', '--init', '--network', 'none',
                           '--cidfile', str(cidfile), image,
                           'python3', '/opt/ci/capabilities.py', 'verify', profile])
        finally:
            if cidfile.exists():
                subprocess.run(['docker', 'rm', '-f', cidfile.read_text().strip()],
                               capture_output=True, timeout=30)
    manifest = json.loads(raw)
    manifest['recipe_base_images'] = [line.split()[1] for line in Path(PROFILES[profile]['dockerfile']).read_text().splitlines() if line.startswith('FROM ') and '@sha256:' in line]
    manifest.update(recipe_commit=commit, image_id=command(['docker', 'image', 'inspect', image, '--format', '{{.Id}}']))
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    sbom = {'spdxVersion': 'SPDX-2.3', 'dataLicense': 'CC0-1.0', 'SPDXID': 'SPDXRef-DOCUMENT',
            'name': f'ci-{profile}', 'documentNamespace': f'https://github.com/jbookout/software-factory/sbom/{commit}/{profile}/{manifest["image_id"].split(":")[1]}',
            'creationInfo': {'creators': ['Tool: software-factory-capabilities'], 'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())},
            'packages': [{'SPDXID': f'SPDXRef-Package-{i}', 'name': name, 'versionInfo': version,
                          'downloadLocation': 'NOASSERTION', 'filesAnalyzed': False,
                          'licenseConcluded': 'NOASSERTION', 'licenseDeclared': 'NOASSERTION',
                          'copyrightText': 'NOASSERTION',
                          'externalRefs': [{'referenceCategory': 'PACKAGE-MANAGER', 'referenceType': 'purl',
                                            'referenceLocator': f'pkg:deb/{name}@{version}?arch={arch}'}]}
                         for i, (name, version, arch) in enumerate(manifest['packages'])]}
    (directory / 'sbom.spdx.json').write_text(json.dumps(sbom, indent=2) + '\n')
    receipt = {'profile': profile, 'recipe_commit': commit, 'image_id': manifest['image_id'],
               'offline': True, 'manifest_sha256': digest(directory / 'manifest.json'),
               'sbom_sha256': digest(directory / 'sbom.spdx.json')}
    (directory / 'qualification.json').write_text(json.dumps(receipt, indent=2) + '\n')


def promote(profile, receipt, image_id, registry_digest, commit, output):
    if (receipt.get('profile') != profile or receipt.get('image_id') != image_id
            or receipt.get('recipe_commit') != commit or receipt.get('offline') is not True
            or not re.fullmatch(r'sha256:[a-f0-9]{64}', registry_digest)
            or not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id)
            or not re.fullmatch(r'[a-f0-9]{40}', commit)
            or any(not re.fullmatch(r'[a-f0-9]{64}', receipt.get(k, ''))
                   for k in ('manifest_sha256', 'sbom_sha256'))):
        raise ValueError('unqualified candidate or immutable identity mismatch')
    output.write_text(json.dumps(dict(receipt, image=f'ghcr.io/jbookout/software-factory/ci-{profile}@{registry_digest}'), indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['verify', 'collect', 'preflight', 'promote'])
    parser.add_argument('profile', choices=PROFILES)
    parser.add_argument('--image')
    parser.add_argument('--commit')
    parser.add_argument('--directory', type=Path, default=Path('qualification'))
    args = parser.parse_args()
    if args.action == 'verify':
        print(json.dumps(verify(args.profile)))
    elif args.action == 'collect':
        collect(args.profile, args.image, args.commit, args.directory)
    else:
        receipt = json.loads((args.directory / 'qualification.json').read_text())
        for name, key in [('manifest.json', 'manifest_sha256'), ('sbom.spdx.json', 'sbom_sha256')]:
            require_version(name, digest(args.directory / name), receipt[key])
        image_id = command(['docker', 'image', 'inspect', args.image, '--format', '{{.Id}}'])
        if args.action == 'preflight':
            registry_digest = 'sha256:' + '0'*64
        else:
            registry_digest = command(['docker', 'image', 'inspect', args.image, '--format', '{{index .RepoDigests 0}}']).split('@')[-1]
        output = args.directory / ('preflight.json' if args.action == 'preflight' else 'pin.json')
        promote(args.profile, receipt, image_id, registry_digest, args.commit, output)
        if args.action == 'preflight':
            output.unlink()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f'qualification failed: {error}', file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stdout, error.stderr, file=sys.stderr)
        raise SystemExit(1)
