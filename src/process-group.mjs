import { spawnSync } from 'node:child_process'

// macOS can report EPERM for a retired group containing only zombie members.
// Permission errors on any live group remain failures; never suppress them by
// errno alone. Observe only PID/group/state, never command arguments or output.
function liveMembers(pid) {
  // The macOS fallback must read the system utility, including when a caller
  // injects a PATH shim for another process observation contract.
  const observation = spawnSync('/bin/ps', ['-g', String(pid), '-o', 'pid=,pgid=,stat='], {
    encoding: 'utf8', timeout: 100, maxBuffer: 1_000_000
  })
  if (!observation.error && observation.status === 1 && !observation.stdout.trim() && !observation.stderr.trim()) return false
  if (observation.error || observation.status !== 0) return null
  const rows = observation.stdout.trim().split('\n').filter(Boolean).map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line))
  if (!rows.length || !rows.every(Boolean)) return null
  return rows.some(row => Number(row[2]) === pid && !row[3].startsWith('Z'))
}
export function ownedGroupAlive(pid) {
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true }
  catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM' && process.platform === 'darwin' && liveMembers(pid) === false) return false
    return true
  }
}
export function killOwnedGroup(pid, signal) {
  try { process.kill(process.platform === 'win32' ? pid : -pid, signal) }
  catch (error) {
    if (error.code === 'ESRCH') return
    if (error.code === 'EPERM' && process.platform === 'darwin' && liveMembers(pid) === false) return
    throw error
  }
}
