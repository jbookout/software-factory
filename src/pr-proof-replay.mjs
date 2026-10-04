import fs from 'node:fs/promises'
import path from 'node:path'
import { runProcess } from './process-runner.mjs'
import { DeliveryError } from './pr-delivery-state.mjs'

// Replay code gets public pinned sources, system tooling and disposable scratch.
// No worker environment, home, credentials, shared Git metadata or network.
export async function runProofReplay(argv, { cwd, consumerDir = cwd, pins, timeoutMs }) {
  const roots = [...new Set(await Promise.all([cwd, consumerDir].map(p => fs.realpath(p))))]
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: cwd, TMPDIR: cwd,
    LANG: 'C', ...pins }
  const command = argv[0] === 'node' ? [process.execPath, ...argv.slice(1)] : argv
  let isolated
  if (process.platform === 'darwin') {
    const profile = ['(version 1)', '(deny default)', '(allow process*)', '(allow sysctl-read)',
      '(allow mach-lookup)', '(allow file-read-metadata)', '(allow file-read* (literal "/"))',
      '(allow system-mac-syscall (mac-policy-name "vnguard"))',
      '(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))',
      '(allow file-map-executable)',
      '(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath "/Library") (subpath "/opt/homebrew") (subpath "/private/var/db") (subpath "/private/etc") (subpath "/private/preboot") (subpath "/dev"))',
      ...roots.map(root => `(allow file-read* file-write* (subpath ${JSON.stringify(root)}))`)].join('\n')
    isolated = ['/usr/bin/sandbox-exec', '-p', profile, ...command]
  } else if (process.platform === 'linux') {
    isolated = ['bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp']
    for (const dir of ['/usr', '/bin', '/lib', '/lib64']) {
      if (await fs.stat(dir).catch(() => null)) isolated.push('--ro-bind', dir, dir)
    }
    if (!process.execPath.startsWith('/usr/') && !process.execPath.startsWith('/bin/'))
      isolated.push('--ro-bind', path.dirname(process.execPath), path.dirname(process.execPath))
    for (const root of roots) isolated.push('--bind', root, root)
    for (const [key, value] of Object.entries(env)) isolated.push('--setenv', key, value)
    isolated.push('--chdir', cwd, '--', ...command)
  } else throw new DeliveryError('proof replay isolation unavailable on this platform', 2)
  try { return await runProcess(isolated, { cwd, env, timeoutMs }) }
  catch { throw new DeliveryError('proof replay isolation unavailable; install the platform sandbox', 2) }
}
