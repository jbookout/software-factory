import contextlib
import io
import importlib.util
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('qualify', Path(__file__).with_name('qualify.py'))
q = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(q)


class QualificationTests(unittest.TestCase):
    def test_rust_compiler_cargo_and_build_are_required(self):
        for fault in ('none', 'rustc', 'cargo', 'version', 'build', 'execution'):
            def run(command, deadline):
                tool = command[0]
                if tool == fault:
                    raise FileNotFoundError(tool)
                if command[-1] == '--version':
                    return f'{tool} 1.{89 if fault == "version" else 90}.0 (hash date)'
                if tool == 'rustc':
                    if fault == 'build':
                        raise subprocess.CalledProcessError(1, command)
                    self.assertIn('--edition=2021', command)
                    return ''
                return 'bad' if fault == 'execution' else 'rust-build-ok'
            with self.subTest(fault=fault), patch.object(q, 'run', side_effect=run):
                if fault == 'none':
                    q.qualify_rust()
                else:
                    with self.assertRaises((RuntimeError, OSError, subprocess.SubprocessError)):
                        q.qualify_rust()

    def test_browser_must_render_and_be_discoverable(self):
        with patch.object(q, 'run', return_value='<title>image-browser-ok</title>') as run:
            q.qualify_browser()
            self.assertIn('/usr/bin/chromium', run.call_args.args[0])
            self.assertIn('--dump-dom', run.call_args.args[0])
        with patch.object(q, 'run', return_value=''):
            with self.assertRaisesRegex(RuntimeError, 'browser'):
                q.qualify_browser()
        with patch.object(q, 'run', side_effect=FileNotFoundError):
            with self.assertRaises(FileNotFoundError):
                q.qualify_browser()

    def test_discoverable_broken_jq_refuses_qualification(self):
        real_run = q.run
        for body, error in (('exit 42', subprocess.CalledProcessError),
                            ('echo wrong-result', RuntimeError)):
            with self.subTest(body=body), tempfile.TemporaryDirectory() as directory:
                jq = Path(directory) / 'jq'
                jq.write_text('#!/bin/sh\n' + body + '\n')
                jq.chmod(0o755)
                def run(command, deadline):
                    return real_run(command, deadline) if command[0] == 'jq' else ''
                which = q.shutil.which
                with patch.dict(os.environ, PATH=directory + os.pathsep + os.environ['PATH']), \
                     patch.object(q.os, 'getuid', return_value=1001), \
                     patch.object(q.shutil, 'which', side_effect=lambda tool: which(tool) if tool == 'jq' else '/synthetic/' + tool), \
                     patch.object(q, 'run', side_effect=run), \
                     patch.object(q, 'qualify_browser'), patch.object(q, 'qualify_rust'), \
                     patch.object(q, 'qualify_major', return_value={}), \
                     patch.object(sys, 'argv', ['qualify.py']), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(which('jq'), str(jq))
                    with self.assertRaises(error):
                        q.main()

    def test_missing_rsync_refuses_image_entrypoint(self):
        with patch.object(q.os, 'getuid', return_value=1001), \
             patch.object(q.shutil, 'which', side_effect=lambda tool: None if tool == 'rsync' else '/synthetic/' + tool), \
             patch.object(sys, 'argv', ['qualify.py']):
            with self.assertRaisesRegex(RuntimeError, 'missing.*rsync'):
                q.main()

    @unittest.skipUnless(shutil.which('zsh') and shutil.which('rsync'), 'requires zsh and rsync')
    def test_skill_sync_copies_as_current_user(self):
        q.qualify_skill_sync()

    @unittest.skipUnless(shutil.which('zsh'), 'requires zsh')
    def test_missing_or_broken_rsync_refuses_qualification(self):
        zsh = shutil.which('zsh')
        for body in (None, 'exit 42', 'exit 0'):
            with self.subTest(body=body), tempfile.TemporaryDirectory() as directory:
                if body is not None:
                    tool = Path(directory) / 'rsync'
                    tool.write_text('#!/bin/sh\n' + body + '\n')
                    tool.chmod(0o755)
                with patch.dict(os.environ, PATH=directory), \
                     patch.object(q.shutil, 'which', return_value=zsh):
                    with self.assertRaises((RuntimeError, subprocess.CalledProcessError)):
                        q.qualify_skill_sync()

    def test_root_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'unprivileged'):
            q.check_user(0)

    def test_missing_binary_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises((FileNotFoundError, RuntimeError)):
                q.qualify_major(17, Path(directory), 1)

    def test_command_deadline_kills_descendants(self):
        with tempfile.TemporaryDirectory() as directory:
            pid = Path(directory) / 'child'
            script = f"import subprocess,time; p=subprocess.Popen(['sleep','30']); open({str(pid)!r},'w').write(str(p.pid)); time.sleep(30)"
            with self.assertRaises(subprocess.TimeoutExpired):
                q.run([sys.executable, '-c', script], q.time.monotonic() + .3)
            child = int(pid.read_text())
            q.time.sleep(.05)
            state = subprocess.run(['ps', '-o', 'stat=', '-p', str(child)], capture_output=True, text=True).stdout.strip()
            self.assertTrue(not state or state.startswith('Z'), state)

    def test_command_failure_refused(self):
        with self.assertRaises(subprocess.CalledProcessError):
            q.run([sys.executable, '-c', 'raise SystemExit(9)'], q.time.monotonic() + 1)

    def test_wrong_major_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / '17/bin'
            binary.mkdir(parents=True)
            for name in q.BINARIES:
                path = binary / name
                path.write_text('#!/bin/sh\necho "postgres (PostgreSQL) 16.1"\n')
                path.chmod(0o755)
            with self.assertRaisesRegex(RuntimeError, 'version'):
                q.qualify_major(17, Path(directory), 1)

    def lifecycle(self, mode, timeout=3):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / '17/bin'
            binary.mkdir(parents=True)
            script = '#!' + sys.executable + '\n' + r'''
import os, pathlib, signal, subprocess, sys, time
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
mode = MODE
if name == 'postgres': print('postgres (PostgreSQL) 17.1')
if name in ('initdb', 'pg_ctl'):
    data = pathlib.Path(args[args.index('-D') + 1])
    data.mkdir(exist_ok=True)
    pidfile = data / 'postmaster.pid'
    if name == 'pg_ctl' and 'start' in args:
        process = subprocess.Popen(['sleep', '30'], start_new_session=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pidfile.write_text(str(process.pid))
        (pathlib.Path(sys.argv[0]).resolve().parents[2] / 'owned.pid').write_text(str(process.pid))
        if mode == 'timeout': time.sleep(30)
    if name == 'pg_ctl' and 'stop' in args:
        os.kill(int(pidfile.read_text()), signal.SIGKILL)
        pidfile.unlink()
if name == 'psql':
    sql = args[-1]
    if sql.startswith('SHOW'): print('170001')
    elif sql.startswith('CREATE') and mode == 'missing-vector': sys.exit(1)
    elif sql.startswith('SELECT') and mode == 'sql-error': sys.exit(2)
    elif '<->' in sql: print('0')
    elif sql.startswith('SELECT'): print('0.8.7')
'''.replace('MODE', repr(mode))
            for name in q.BINARIES:
                path = binary / name
                path.write_text(script)
                path.chmod(0o755)
            try:
                return q.qualify_major(17, root, timeout)
            finally:
                if (root / 'owned.pid').exists():
                    pid = (root / 'owned.pid').read_text()
                    q.time.sleep(.05)
                    state = subprocess.run(['ps', '-o', 'stat=', '-p', pid], capture_output=True, text=True).stdout.strip()
                    self.assertTrue(not state or state.startswith('Z'), state)

    def test_success_restores_and_stops(self):
        self.assertEqual(self.lifecycle('success')['server_version_num'], 170001)

    def test_missing_vector_refused_and_stopped(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.lifecycle('missing-vector')

    def test_sql_failure_refused_and_stopped(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.lifecycle('sql-error')

    def test_start_timeout_stops_late_server(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.lifecycle('timeout', .5)


if __name__ == '__main__':
    unittest.main()
