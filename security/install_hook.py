#!/usr/bin/env python3
"""Install this worktree's leak hook without redirecting other worktrees."""
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parents[1]
hooks = root / ('ops/githooks' if (root / 'ops/githooks/pre-push').exists() else 'security')
(hooks / 'pre-push').chmod(0o755)
subprocess.run(['git', '-C', str(root), 'config', 'extensions.worktreeConfig', 'true'], check=True)
subprocess.run(['git', '-C', str(root), 'config', '--worktree', 'core.hooksPath', str(hooks)], check=True)
print('Worktree-local pre-push hook installed.')
