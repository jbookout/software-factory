"""Metered TypeSafe call for the installed browser skill, with the factory ledger."""

import hashlib
import json
import os
import sqlite3
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ENDPOINT = "https://api.typesafe.ai/v1/systemone"
STATE_DIR = Path.home() / ".local" / "state" / "software-factory"
USAGE_LOG = STATE_DIR / "jev-calls.jsonl"
CACHE_PATH = STATE_DIR / "jev-cache.sqlite3"


def _sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _append(path, row):
    if path is None:
        return
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("a", encoding="utf-8") as handle:
        os.chmod(path, 0o600)
        handle.write(json.dumps(row, sort_keys=True) + "\n")


def _cache(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(path, timeout=2)
    os.chmod(path, 0o600)
    db.execute("create table if not exists answers (key text primary key, expires real, result text)")
    return db


def ask(payload, key, *, opener=None, usage_log=None, cache_path=None):
    """Ask once; record measured usage. An injected opener stays offline by default."""
    sender = opener or urllib.request.urlopen
    log = USAGE_LOG if usage_log is None and opener is None else usage_log
    cache_file = CACHE_PATH if cache_path is None and opener is None else cache_path
    body = json.dumps(payload).encode("utf-8")
    prompt_hash = hashlib.sha256(body).hexdigest()
    cache_key = _sha(json.dumps({"endpoint": ENDPOINT, "credential": _sha(key),
                                 "caller": "jev-browser-select", "prompt": prompt_hash}, sort_keys=True))
    base = {"ts": datetime.now(timezone.utc).isoformat(),
            "session": os.environ.get("CODEX_THREAD_ID") or os.environ.get("CLAUDE_CODE_SESSION_ID"),
            "caller": "jev-browser-select", "prompt_sha256": prompt_hash,
            "question_ids_sha256": [_sha(q) for q in sorted(payload["questions"])],
            "question_kind": ",".join(sorted({q["type"] for q in payload["questions"].values()})),
            "facets": [], "model": payload["model"]}
    if cache_file is not None:
        try:
            with _cache(cache_file) as db:
                row = db.execute("select expires, result from answers where key=?", (cache_key,)).fetchone()
            if row and row[0] > time.time():
                result = json.loads(row[1])
                _append(log, {**base, "model": result["model"], "usage": None,
                              "ok": False, "cache_hit": True})
                return {**result, "usage": None, "cache_hit": True}
        except (OSError, sqlite3.Error, ValueError):
            pass
    request = urllib.request.Request(ENDPOINT, data=body, method="POST", headers={
        "authorization": f"Bearer {key}", "content-type": "application/json",
    })
    try:
        with sender(request, timeout=12) as response:
            result = json.load(response)
        usage = result.get("usage") if isinstance(result.get("usage"), dict) else None
        _append(log, {**base, "model": result.get("model"), "usage": usage,
                      "ok": True, "cache_hit": False})
        if cache_file is not None and result.get("model") and isinstance(usage, dict) and \
                isinstance(usage.get("input_tokens"), int) and usage["input_tokens"] >= 0:
            try:
                with _cache(cache_file) as db:
                    db.execute("insert or replace into answers values (?,?,?)",
                               (cache_key, time.time() + 60, json.dumps({
                                   "model": result["model"], "answers": result.get("answers", {})})))
            except (OSError, sqlite3.Error, ValueError):
                pass
        return result
    except Exception as exc:
        _append(log, {**base, "usage": None, "ok": False, "cache_hit": False,
                      "error": type(exc).__name__})
        raise
