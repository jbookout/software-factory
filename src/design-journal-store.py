"""Private, transactional SQLite adapter for design-journal.mjs.

One host owns this local directory. flock serializes file archiving with SQLite
transactions and snapshots. This is not a network filesystem or an MCP server.
Unreferenced blobs left by interrupted commits are harmless; records are atomic.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
from urllib.parse import quote

MAX_DATABASE_BYTES = 16 * 1024 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024 - 1  # newline belongs to the transport budget
MAX_REQUEST_BYTES = 1024 * 1024

SCHEMA = """
CREATE TABLE scopes (scope TEXT PRIMARY KEY, identity TEXT NOT NULL,
  revision INTEGER NOT NULL, view TEXT, view_digest TEXT);
CREATE TABLE events (scope TEXT NOT NULL REFERENCES scopes(scope), revision INTEGER NOT NULL,
  key TEXT NOT NULL, request TEXT NOT NULL, request_digest TEXT NOT NULL, request_text_digest TEXT NOT NULL,
  result TEXT NOT NULL, result_digest TEXT NOT NULL,
  PRIMARY KEY(scope,revision), UNIQUE(scope,key));
CREATE TABLE records (scope TEXT NOT NULL REFERENCES scopes(scope), id TEXT NOT NULL,
  kind TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(scope,id));
CREATE TABLE artifacts (scope TEXT NOT NULL REFERENCES scopes(scope), digest TEXT NOT NULL, origin TEXT NOT NULL,
  PRIMARY KEY(scope,digest));
PRAGMA user_version=1;
"""
for table in ("events", "records", "artifacts"):
    for action in ("UPDATE", "DELETE"):
        SCHEMA += (f"CREATE TRIGGER immutable_{table}_{action} BEFORE {action} ON {table} "
                   "BEGIN SELECT RAISE(ABORT, 'immutable journal record'); END;\n")


def digest(value):
    if isinstance(value, str):
        value = value.encode()
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def private_path(raw, create=False, new=False):
    if not isinstance(raw, str) or not raw:
        raise ValueError("private directory path required")
    requested = Path(raw).absolute()
    if requested.is_symlink():
        raise ValueError("symlink directory refused")
    target = requested.resolve()
    for parent in (target, *target.parents):
        if (parent / ".git").exists() or (parent / ".git").is_symlink():
            raise ValueError("private state must be outside every Git checkout")
    if new and target.exists():
        raise ValueError("destination exists; never overwrite a journal or backup")
    if create:
        target.mkdir(mode=0o700, parents=True, exist_ok=not new)
    info = target.lstat()
    check_directory(info)
    return target


def check_file(info, mode):
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != mode):
        raise ValueError("private regular file required; links refused")


def regular_file(path, mode):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        check_file(info, mode)
        return info
    finally:
        os.close(fd)


def regular_bytes(path, mode, max_bytes=MAX_DATABASE_BYTES):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        check_file(info, mode)
        if info.st_size > max_bytes:
            raise ValueError("file size budget exceeded")
        with os.fdopen(fd, "rb", closefd=False) as file:
            data = file.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError("file size budget exceeded")
        return data
    finally:
        os.close(fd)


def write_new(path, data, mode=0o400):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "wb", closefd=False) as file:
            file.write(data)
            file.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def sync_directory(root):
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def connect(root, initialize=False):
    path = root / "journal.sqlite"
    if initialize:
        write_new(path, b"", 0o600)
    regular_file(path, 0o600)
    # rw cannot fabricate a database if the named file disappears.
    db = sqlite3.connect(f"file:{quote(str(path))}?mode=rw", uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA synchronous=FULL")
    version = db.execute("PRAGMA user_version").fetchone()[0]
    if version == 0 and initialize:
        # Only a genuinely empty database may acquire the first migration.
        if db.execute("SELECT count(*) FROM sqlite_master").fetchone()[0]:
            raise ValueError("unversioned nonempty journal refused")
        db.executescript("BEGIN IMMEDIATE;" + SCHEMA + "COMMIT;")
    elif version != 1:
        raise ValueError("unsupported journal migration version")
    return db


def database_identity(root):
    try:
        info = regular_file(root / "journal.sqlite", 0o600)
    except FileNotFoundError as error:
        raise ValueError("journal database missing; restore accepted history into a new root") from error
    return {"device": info.st_dev, "inode": info.st_ino}


def seal_database(root):
    write_new(root / "database-identity.json", encoded(database_identity(root)).encode())
    sync_directory(root)


def checked_json(text, expected):
    if digest(text) != expected:
        raise ValueError("stored record digest mismatch")
    return json.loads(text)


def read_blob(root, value):
    if len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise ValueError("invalid artifact digest")
    # Pin this subdirectory too: neither root nor artifacts pathname replacement
    # may redirect an operation after its checks. cwd is private to this process.
    fd = os.open(root / "artifacts", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    parent = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
    try:
        check_directory(os.fstat(fd))
        os.fchdir(fd)
        data = regular_bytes(value, 0o400, 1024 * 1024)
    finally:
        os.fchdir(parent)
        os.close(parent)
        os.close(fd)
    if digest(data) != value:
        raise ValueError("artifact digest mismatch")
    return data


def publish_blob(root, value, data):
    fd = os.open(root / "artifacts", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    parent = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
    temporary = None
    try:
        check_directory(os.fstat(fd))
        os.fchdir(fd)
        if Path(value).exists() or Path(value).is_symlink():
            stored = regular_bytes(value, 0o400, 1024 * 1024)
            if digest(stored) != value or stored != data:
                raise ValueError("artifact digest mismatch")
            return
        temp_fd, temporary = tempfile.mkstemp(prefix=".archive-", dir=".")
        try:
            os.fchmod(temp_fd, 0o400)
            with os.fdopen(temp_fd, "wb", closefd=False) as file:
                file.write(data)
                file.flush()
                os.fsync(temp_fd)
        finally:
            os.close(temp_fd)
        if digest(regular_bytes(temporary, 0o400, 1024 * 1024)) != value:
            raise ValueError("artifact digest mismatch")
        # Root lock serializes publishers; only complete durable bytes get the
        # final name. Process-death temporary files are ignored by reads/backups.
        os.rename(temporary, value)
        temporary = None
        os.fsync(fd)
    finally:
        if temporary is not None:
            os.unlink(temporary)
        os.fchdir(parent)
        os.close(parent)
        os.close(fd)


def check_directory(info):
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("directory must be private, user-owned and mode 700")


def bounded(value, reserve=0):
    if len(encoded(value).encode()) > MAX_OUTPUT_BYTES - reserve:
        raise ValueError("journal projection/output size budget exceeded")
    return value


def scope_key(scope):
    return digest(encoded(scope))


def replay(db, scope, key, request_digest):
    event = db.execute("SELECT * FROM events WHERE scope=? AND key=?", (scope, key)).fetchone()
    if not event:
        return None
    checked_json(event["request"], event["request_text_digest"])
    if event["request_digest"] != request_digest:
        raise ValueError("idempotency conflict: the key already binds another command")
    return checked_json(event["result"], event["result_digest"])


def state(db, scope):
    current = db.execute("SELECT * FROM scopes WHERE scope=?", (scope,)).fetchone()
    events = []
    for event in db.execute("SELECT * FROM events WHERE scope=? ORDER BY revision", (scope,)):
        request = checked_json(event["request"], event["request_text_digest"])
        result = checked_json(event["result"], event["result_digest"])
        if event["revision"] != len(events) + 1 or result["revision"] != event["revision"]:
            raise ValueError("incomplete journal event history")
        events.append({"revision": event["revision"], "request": request, "result": result})
    revision = current["revision"] if current else 0
    if revision != len(events):
        raise ValueError("incomplete journal revision history")
    records = []
    for record in db.execute("SELECT * FROM records WHERE scope=? ORDER BY revision", (scope,)):
        records.append({"kind": record["kind"], "record": checked_json(record["payload"], record["digest"]),
                        "revision": record["revision"], "digest": record["digest"]})
    view = checked_json(current["view"], current["view_digest"]) if current and current["view"] else None
    # Reconstruct projections from the immutable event ledger. A database
    # checksum alone cannot detect an accidentally omitted rejected record.
    expected_records, expected_artifacts, expected_view = [], {}, None
    for event in events:
        request, result = event["request"], event["result"]
        if request["expectedRevision"] != event["revision"] - 1:
            raise ValueError("incomplete revision event history")
        if request["command"] == "append":
            expected_records.append((request["kind"], request["record"], event["revision"]))
        elif request["command"] == "archive":
            value = request["artifactDigest"]
            if result["artifact"] != {"ref": "sha256:" + value, "digest": value}:
                raise ValueError("artifact event digest mismatch")
            expected_artifacts[value] = request["origin"]
        else:
            expected_view = result["view"]
    if expected_records != [(row["kind"], row["record"], row["revision"]) for row in records]:
        raise ValueError("incomplete record history")
    if expected_view != view:
        raise ValueError("interview projection differs from event history")
    actual_artifacts = dict(db.execute("SELECT digest,origin FROM artifacts WHERE scope=?", (scope,)))
    if actual_artifacts != expected_artifacts:
        raise ValueError("incomplete artifact history")
    return bounded({"revision": revision, "records": records, "events": events, "view": view,
            "authority": "reported-only", "hostQualification": {"status": "blocked",
                "reason": "Joe must choose the persistent factory host and authorize cost; laptop-off qualification remains required"}},
        reserve=1024)  # restore inspection wraps the state with its database digest


def commit(db, root, scope, identity, request):
    command = request["request"]
    db.execute("BEGIN IMMEDIATE")
    try:
        prior = replay(db, scope, command["idempotencyKey"], request["requestDigest"])
        if prior is not None:
            db.rollback()
            return prior
        if len(request["requestText"].encode()) > MAX_REQUEST_BYTES:
            raise ValueError("journal request size budget exceeds 1 MiB")
        current = state(db, scope)
        if command["expectedRevision"] != current["revision"]:
            raise ValueError("revision conflict: reread the project")
        # Every supplied reference must already belong to this scope and match bytes.
        for ref in request["refs"]:
            value = ref["digest"]
            if ref["ref"] != "sha256:" + value or not db.execute(
                    "SELECT 1 FROM artifacts WHERE scope=? AND digest=?", (scope, value)).fetchone():
                raise ValueError("artifact reference not registered in this scope")
            read_blob(root, value)
            if command["command"] == "append" and command["kind"] == "reference":
                origin = db.execute("SELECT origin FROM artifacts WHERE scope=? AND digest=?", (scope, value)).fetchone()[0]
                if command["record"]["origin"] != origin:
                    raise ValueError("reference origin differs from immutable archived provenance")
        if not db.execute("SELECT 1 FROM scopes WHERE scope=?", (scope,)).fetchone():
            db.execute("INSERT INTO scopes VALUES(?,?,0,NULL,NULL)", (scope, encoded(identity)))
        revision = current["revision"] + 1
        result = {"revision": revision}
        if command["command"] == "archive":
            data = base64.b64decode(command["bytes"], validate=True)
            value = digest(data)
            publish_blob(root, value, data)
            prior_origin = db.execute("SELECT origin FROM artifacts WHERE scope=? AND digest=?", (scope, value)).fetchone()
            if prior_origin and prior_origin[0] != command["origin"]:
                raise ValueError("immutable artifact origin conflicts with archived provenance")
            db.execute("INSERT OR IGNORE INTO artifacts VALUES(?,?,?)", (scope, value, command["origin"]))
            result["artifact"] = {"ref": "sha256:" + value, "digest": value}
        elif command["command"] == "append":
            try:
                db.execute("INSERT INTO records VALUES(?,?,?,?,?,?)", (scope, request["recordId"], command["kind"],
                           request["recordText"], digest(request["recordText"]), revision))
            except sqlite3.IntegrityError as error:
                raise ValueError("immutable record ID already exists") from error
            result["recordId"] = request["recordId"]
        else:
            db.execute("UPDATE scopes SET view=?,view_digest=? WHERE scope=?",
                       (request["viewText"], digest(request["viewText"]), scope))
            result["view"] = json.loads(request["viewText"])
        db.execute("UPDATE scopes SET revision=? WHERE scope=?", (revision, scope))
        result_text = encoded(result)
        db.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)", (scope, revision, command["idempotencyKey"],
                   request["requestText"], request["requestDigest"], digest(request["requestText"]), result_text, digest(result_text)))
        # Measure proposed logical pages and the complete externally readable
        # projection inside the transaction. Rollback preserves accepted history.
        if db.execute("PRAGMA page_count").fetchone()[0] * db.execute("PRAGMA page_size").fetchone()[0] > MAX_DATABASE_BYTES:
            raise ValueError("journal database size budget exceeded")
        state(db, scope)
        bounded(result)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def backup(db, root, scope, identity, destination):
    # Read and verify everything before creating a destination. A completed
    # manifest is written last, so interrupted snapshots are never restorable.
    state(db, scope)
    blobs = {row[0]: read_blob(root, row[0]) for row in db.execute(
        "SELECT digest FROM artifacts WHERE scope=?", (scope,))}
    destination = private_path(destination, create=True, new=True)
    private_path(str(destination / "artifacts"), create=True)
    copy = connect(destination, initialize=True)
    try:
        with copy:
            for table in ("scopes", "events", "records", "artifacts"):
                rows = db.execute(f"SELECT * FROM {table} WHERE scope=?", (scope,)).fetchall()
                for row in rows:
                    placeholders = ",".join("?" for _ in row)
                    copy.execute(f"INSERT INTO {table} VALUES({placeholders})", tuple(row))
    finally:
        copy.close()
    for value, data in blobs.items():
        write_new(destination / "artifacts" / value, data)
    db_digest = digest(regular_bytes(destination / "journal.sqlite", 0o600))
    manifest = {"schema": "design-journal-backup.v1", "scope": identity, "databaseDigest": db_digest,
                "artifacts": sorted(blobs)}
    write_new(destination / "manifest.json", encoded(manifest).encode())
    sync_directory(destination / "artifacts")
    sync_directory(destination)
    return {"schema": manifest["schema"], "databaseDigest": db_digest, "artifacts": len(blobs)}


def restore(request):
    backup_root = private_path(request["backupRoot"])
    manifest = json.loads(regular_bytes(backup_root / "manifest.json", 0o400))
    if manifest.get("schema") != "design-journal-backup.v1" or manifest.get("scope") != request["scope"]:
        raise ValueError("backup scope mismatch")
    database = regular_bytes(backup_root / "journal.sqlite", 0o600)
    if digest(database) != manifest["databaseDigest"]:
        raise ValueError("backup database digest mismatch")
    private_path(str(backup_root / "artifacts"))
    blobs = {value: read_blob(backup_root, value) for value in manifest["artifacts"]}
    # Inspection and installation use the same captured bytes, never a second
    # pathname read of the database after its checksum was checked.
    source = sqlite3.connect(":memory:")
    source.deserialize(database)
    source.row_factory = sqlite3.Row
    try:
        if source.execute("PRAGMA user_version").fetchone()[0] != 1 or source.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("backup database incomplete")
        scope = scope_key(request["scope"])
        for table in ("scopes", "events", "records", "artifacts"):
            if source.execute(f"SELECT count(*) FROM {table} WHERE scope<>?", (scope,)).fetchone()[0]:
                raise ValueError("backup contains another scope")
        if sorted(row[0] for row in source.execute("SELECT digest FROM artifacts")) != sorted(blobs):
            raise ValueError("incomplete backup artifact manifest")
        snapshot = state(source, scope)
    finally:
        source.close()
    if request["op"] == "inspect-backup":
        return bounded({"snapshot": snapshot, "databaseDigest": digest(database)})
    if digest(database) != request["databaseDigest"]:
        raise ValueError("backup changed after semantic inspection")
    root = private_path(request["root"], create=True, new=True)
    private_path(str(root / "artifacts"), create=True)
    write_new(root / "journal.sqlite", database, 0o600)
    seal_database(root)
    for value, data in blobs.items():
        write_new(root / "artifacts" / value, data)
    sync_directory(root / "artifacts")
    sync_directory(root)
    return {"restored": True}


def run(request):
    os.umask(0o077)
    if not hasattr(sqlite3.Connection, "deserialize"):
        raise ValueError("Python 3.11+ with SQLite deserialization support is required")
    if request["op"] in ("restore", "inspect-backup"):
        return restore(request)
    root = private_path(request["root"], create=request["op"] == "open")
    lock = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    db = None
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        info = os.fstat(lock)
        check_directory(info)
        named = root.lstat()
        if root.is_symlink() or (named.st_dev, named.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("private journal directory identity changed while waiting for lock")
        private_path(str(root))
        identity = {"root": str(root), "device": info.st_dev, "inode": info.st_ino}
        if request.get("identity") and request["identity"] != identity:
            raise ValueError("private journal directory identity changed")
        # Resolve subsequent files relative to the locked directory, so renaming
        # its old pathname cannot switch our storage to a different directory.
        os.fchdir(lock)
        root = Path(".")
        # Decide initialization only under the lock. An existing, genuinely
        # empty private root is fresh; any persisted contents require its seal.
        initialize = request["op"] == "open" and not any(root.iterdir())
        private_path(str(root / "artifacts"), create=initialize)
        if not initialize:
            expected = json.loads(regular_bytes(root / "database-identity.json", 0o400))
            if database_identity(root) != expected:
                raise ValueError("journal database identity changed")
        db = connect(root, initialize=initialize)
        if initialize:
            seal_database(root)
        scope = scope_key(request["scope"])
        op = request["op"]
        if op == "open":
            return identity
        if op == "read":
            return state(db, scope)
        if op == "replay":
            return replay(db, scope, request["key"], request["requestDigest"])
        if op == "commit":
            return commit(db, root, scope, request["scope"], request)
        if op == "artifact":
            ref = request["ref"]
            if not isinstance(ref, str) or not ref.startswith("sha256:") or len(ref) != 71:
                raise ValueError("invalid artifact reference")
            value = ref[7:]
            if not db.execute("SELECT 1 FROM artifacts WHERE scope=? AND digest=?", (scope, value)).fetchone():
                raise ValueError("artifact does not belong to this scope")
            return base64.b64encode(read_blob(root, value)).decode()
        if op == "backup":
            return backup(db, root, scope, request["scope"], request["destination"])
        raise ValueError("unknown storage operation")
    finally:
        if db:
            db.close()
        os.close(lock)


if __name__ == "__main__":
    try:
        print(encoded(bounded(run(json.load(sys.stdin)))))
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
