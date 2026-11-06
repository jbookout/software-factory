"""Offline qualification of the CI job image. Nonzero means do not publish."""
import argparse
import json
import os
import pwd
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

BINARIES = ('initdb', 'pg_ctl', 'postgres', 'psql', 'createdb', 'pg_dump', 'pg_restore')
DOCUMENT_TOOLS = ('libreoffice', 'pdftotext', 'zsh', 'git', 'make', 'g++')


def check_user(uid):
    if uid == 0:
        raise RuntimeError('qualification requires an unprivileged job-container user')


def run(command, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise subprocess.TimeoutExpired(command, 0)
    process = subprocess.Popen([str(arg) for arg in command], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=min(20, remaining))
    except BaseException:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, command, stdout, stderr)
    return stdout.strip()


def qualify_major(major, root=Path('/usr/lib/postgresql'), timeout=60):
    deadline = time.monotonic() + timeout
    binaries = root / str(major) / 'bin'
    for name in BINARIES:
        if not os.access(binaries / name, os.X_OK):
            raise RuntimeError(f'missing executable: {binaries / name}')
    version = run([binaries / 'postgres', '--version'], deadline)
    if f'(PostgreSQL) {major}.' not in version:
        raise RuntimeError(f'wrong server version: {version}')
    with tempfile.TemporaryDirectory(prefix=f'qualify-pg{major}-') as directory:
        folder = Path(directory)
        data = folder / 'data'
        log = folder / 'postgres.log'
        try:
            run([binaries / 'initdb', '-D', data, '-A', 'trust', '--no-locale'], deadline)
            run([binaries / 'pg_ctl', '-D', data, '-l', log, '-o',
                 f"-k {folder} -c listen_addresses=''", '-w', 'start'], deadline)
            connection = ['-h', folder, '-U', pwd.getpwuid(os.getuid()).pw_name]
            sql = [binaries / 'psql', *connection, '-d', 'postgres', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c']
            number = run([*sql, 'SHOW server_version_num'], deadline)
            if int(number) // 10000 != major:
                raise RuntimeError(f'wrong running server version: {number}')
            run([*sql, 'CREATE EXTENSION vector'], deadline)
            if run([*sql, "SELECT '[1,2,3]'::vector <-> '[1,2,3]'::vector"], deadline) != '0':
                raise RuntimeError('vector distance failed')
            archive = folder / 'database.dump'
            run([binaries / 'pg_dump', *connection, '-d', 'postgres', '-Fc', '-f', archive], deadline)
            run([binaries / 'createdb', *connection, 'restored'], deadline)
            run([binaries / 'pg_restore', *connection, '-d', 'restored', '--exit-on-error', archive], deadline)
            restored = run([binaries / 'psql', *connection, '-d', 'restored', '-XAt', '-v',
                            'ON_ERROR_STOP=1', '-c', "SELECT extversion FROM pg_extension WHERE extname='vector'"], deadline)
            if not restored:
                raise RuntimeError('restored vector extension absent')
            return {'major': major, 'server_version_num': int(number), 'vector': restored}
        finally:
            if sys.exc_info()[0] and log.exists():
                print(log.read_text()[-8000:], file=sys.stderr)
            if (data / 'postmaster.pid').exists():
                pid = int((data / 'postmaster.pid').read_text().splitlines()[0])
                try:
                    run([binaries / 'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'], time.monotonic() + 5)
                except (subprocess.SubprocessError, OSError):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                if (data / 'postmaster.pid').exists():
                    raise RuntimeError(f'cluster cleanup failed; see {log}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--majors', nargs='+', type=int, choices=(17, 18), default=[17, 18])
    args = parser.parse_args()
    check_user(os.getuid())
    for directory in (Path.home(), Path.cwd(), Path(os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))):
        with tempfile.TemporaryFile(dir=directory):
            pass
    for tool in DOCUMENT_TOOLS:
        if not shutil.which(tool):
            raise RuntimeError(f'missing document/build tool: {tool}')
    run(['libreoffice', '--version'], time.monotonic() + 20)
    print(json.dumps({'uid': os.getuid(), 'tools': DOCUMENT_TOOLS,
                      'postgres': [qualify_major(major) for major in args.majors]}))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError) as error:
        print(f'qualification failed: {error}', file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr, file=sys.stderr)
        raise SystemExit(1)
