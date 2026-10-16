"""Local private SQLite records and SQLite backup. Existing tables are retained."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
from urllib.parse import quote


def private_directory(raw, create=False):
    requested = Path(raw).absolute()
    if requested.is_symlink():
        raise ValueError("symlink directory refused")
    root = requested.resolve()
    if any((parent / ".git").exists() for parent in (root, *root.parents)):
        raise ValueError("private state must be outside every Git checkout")
    if create:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = root.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("directory must be private, user-owned and mode 700")
    return root


def run(request):
    os.umask(0o077)
    root = private_directory(request["root"], create=True)
    file = root / "journal.sqlite"
    if not file.exists():
        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(fd)
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError("private regular database required")
    db = sqlite3.connect(f"file:{quote(str(file))}?mode=rw", uri=True, timeout=10)
    try:
        db.execute("CREATE TABLE IF NOT EXISTS notes (scope TEXT, id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL)")
        scope = hashlib.sha256(json.dumps(request["scope"], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        if request["op"] == "append":
            with db:
                cursor = db.execute("INSERT INTO notes(scope,kind,payload) VALUES(?,?,?)", (scope, request["kind"], json.dumps(request["record"])))
            return {"id": cursor.lastrowid}
        if request["op"] == "read":
            records = [{"id": row[0], "kind": row[1], "record": json.loads(row[2])} for row in db.execute(
                "SELECT id,kind,payload FROM notes WHERE scope=? ORDER BY id", (scope,))]
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            legacy = {}
            for table in ("scopes", "records", "events", "artifacts"):
                if table in tables:
                    db.row_factory = sqlite3.Row
                    legacy[table] = [dict(row) for row in db.execute(f"SELECT * FROM {table} WHERE scope=?", (scope,))]
            return {"records": records, "existing": legacy}
        if request["op"] == "backup":
            destination = private_directory(request["destination"], create=True) / "journal.sqlite"
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            copy = sqlite3.connect(destination)
            try:
                db.backup(copy)
            finally:
                copy.close()
            return {"database": str(destination)}
        raise ValueError("unknown journal operation")
    finally:
        db.close()


if __name__ == "__main__":
    try:
        print(json.dumps(run(json.load(sys.stdin))))
    except (OSError, ValueError, KeyError, sqlite3.Error) as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
