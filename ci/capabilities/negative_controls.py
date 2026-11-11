"""Mutate isolated candidates and require verification to refuse them."""
from pathlib import Path
import subprocess
import sys
from capabilities import PROFILES

profile, image = sys.argv[1:]
tool = PROFILES[profile]['tools'][0]
mutations = [f'rm "$(command -v {tool})"']
if PROFILES[profile]['node']:
    mutations.append("printf '#!/bin/sh\\necho v0.0.0\\n' > /usr/local/bin/node && chmod +x /usr/local/bin/node")
if PROFILES[profile]['playwright']:
    mutations.append('rm -rf /ms-playwright/webkit-*')
if PROFILES[profile].get('pg_dump'):
    mutations.append('rm /usr/lib/postgresql/18/bin/pg_dump')
for index, mutation in enumerate(mutations):
    tag = f'ci-negative:{profile}-{index}'
    recipe = f'FROM {image}\nUSER root\nRUN {mutation}\nUSER 1001:1001\n'
    subprocess.run(['docker', 'build', '--network', 'none', '-t', tag, '-'], input=recipe, text=True, check=True, timeout=120)
    result = subprocess.run(['docker', 'run', '--rm', '--init', '--network', 'none', tag,
                             'python3', '/opt/ci/capabilities.py', 'verify', profile], capture_output=True, text=True, timeout=240)
    Path(f'qualification/negative-{index}.log').write_text(result.stdout + result.stderr)
    if result.returncode == 0:
        raise SystemExit(f'negative control accepted mutation {index}')
