import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

async function resourceSnapshot() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,%cpu=,rss='], { timeout: 2000 })
  return stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
}

export function observeCheckResources(pid, { intervalMs = 250, snapshot = resourceSnapshot } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 20 || intervalMs > 10000) throw new Error('invalid resource sample interval')
  let busy = false, samples = 0, errors = 0, peakRssKiB = 0, peakReportedCpuPercent = 0
  const sample = async () => {
    busy = true
    try {
      const rows = await snapshot()
      if (rows.some(row => row.length !== 4 || row.some(value => !Number.isFinite(value)))) throw new Error('invalid resource observation')
      const parents = new Map(rows.map(row => [row[0], row[1]]))
      const owned = rows.filter(row => {
        let ancestor = row[0]
        const seen = new Set()
        while (ancestor && ancestor !== pid && !seen.has(ancestor)) { seen.add(ancestor); ancestor = parents.get(ancestor) }
        return ancestor === pid
      })
      peakRssKiB = Math.max(peakRssKiB, owned.reduce((sum, row) => sum + row[3], 0))
      peakReportedCpuPercent = Math.max(peakReportedCpuPercent, owned.reduce((sum, row) => sum + row[2], 0))
      samples++
    } catch { errors++ } finally { busy = false }
  }
  let pending = sample()
  const timer = setInterval(() => { if (!busy) pending = sample() }, intervalMs)
  return async () => {
    clearInterval(timer)
    await pending
    return { samples, observationErrors: errors, intervalMs,
      peakRssKiB: samples ? peakRssKiB : null, peakReportedCpuPercent: samples ? peakReportedCpuPercent : null }
  }
}
