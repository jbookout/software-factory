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
  if (observation.error || observation.stderr?.trim()) return null
  // ps exits 1 with empty output when the selected group has no members.
  if (observation.status === 1 && !observation.stdout.trim()) return false
  if (observation.status !== 0) return null
  const rows = observation.stdout.trim().split('\n').filter(Boolean).map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line))
  if (!rows.length || !rows.every(row => row && Number(row[2]) === pid)) return null
  return rows.some(row => !row[3].startsWith('Z'))
}
// A killed group can still be retiring at the first readback. Both probes are
// bounded; a live group or two inconclusive observations remain a refusal.
const retiredGroup = pid => liveMembers(pid) === false || liveMembers(pid) === false
export function ownedGroupAlive(pid) {
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true }
  catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM' && process.platform === 'darwin' && retiredGroup(pid)) return false
    return true
  }
}
export function killOwnedGroup(pid, signal) {
  try { process.kill(process.platform === 'win32' ? pid : -pid, signal) }
  catch (error) {
    if (error.code === 'ESRCH') return
    if (error.code === 'EPERM' && process.platform === 'darwin' && retiredGroup(pid)) return
    throw error
  }
}
