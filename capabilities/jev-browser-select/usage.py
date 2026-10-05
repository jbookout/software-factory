"""Browser judgments consume CARR's shared admission, cache and receipts."""

import importlib.util
import os
import re
import subprocess
from pathlib import Path


def _shared_ask(payload, key):
    root = Path(os.environ.get("CARR_REPO_ROOT", Path.home() / "carr-system"))
    revision = os.environ.get("CARR_JEV_SOURCE_SHA", "")
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise RuntimeError("CARR Jev source revision required")
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True,
                          text=True, check=True).stdout.strip()
    dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=root,
                           capture_output=True, text=True, check=True).stdout.strip()
    if head != revision or dirty:
        raise RuntimeError("CARR Jev source revision mismatch")
    spec = importlib.util.spec_from_file_location("carr_browser_jev", root / "ops/typesafe_client.py")
    client = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(client)
    return client.ask(**payload, api_key=key, caller="adhoc:factory:jev-browser-select",
                      session_id=os.environ.get("CODEX_THREAD_ID") or os.environ.get("CLAUDE_CODE_SESSION_ID"))


def ask(payload, key, *, shared_ask=None):
    return (shared_ask or _shared_ask)(payload, key)
