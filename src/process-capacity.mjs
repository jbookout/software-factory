import { DeadlineError } from './deadline.mjs'
import path from 'node:path'
import fs from 'node:fs/promises'
import { runProcess } from './process-runner.mjs'
import { acquireLease, withLease, readJson } from './pr-delivery-state.mjs'

export async function processSnapshot(budget) {
  const result = await runProcess(['ps', '-axo', 'pid=,ppid=,args='], {
    timeoutMs: Math.max(1, Math.floor(Math.min(5000, budget.remaining())))
  })
  if (result.timedOut) throw new DeadlineError(budget.phase)
  if (result.code) throw new Error('resource observation unavailable')
  const rows = result.stdout.trim().split('\n').filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    if (!match) throw new Error('resource observation unavailable')
    return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }
  })
  if (!rows.length) throw new Error('resource observation unavailable')
  return rows
}

function descends(pid, roots, parents) {
  const seen = new Set()
  while (pid && !seen.has(pid)) {
    if (roots.has(pid)) return true
    seen.add(pid); pid = parents.get(pid)
  }
  return false
}
function unmanagedUnits(rows, owned, browserConcurrency) {
  const parents = new Map(rows.map(row => [row.pid, row.ppid]))
  const tests = rows.filter(row => /^(?:\S*\/)?node\s+(?:(?:--[\w-]+(?:=[^ ]+)?|-r\s+[^ ]+)\s+)*--test(?:\s|=|$)/.test(row.command))
  const testRoots = new Set(tests.map(row => row.pid))
  const browsers = rows.filter(row => /(?:chrome|chromium|firefox|webkit|playwright)/i.test(row.command.split(" ")[0]))
  const browserRoots = new Set(browsers.map(row => row.pid))
  let units = 0
  for (const row of tests) {
    if (descends(row.pid, owned, parents) || descends(row.ppid, testRoots, parents)) continue
    // Unmanaged supported launcher flags are counted, not silently reduced to
    // the factory default. Unknown launchers consume the declared worker cap.
    const requested = /--test-concurrency(?:=|\s+)(\d+)/.exec(row.command)?.[1]
    const root = new Set([row.pid])
    const activeWorkers = rows.filter(worker => worker.pid !== row.pid &&
      /^(?:\S*\/)?node\s/.test(worker.command) && descends(worker.pid, root, parents)).length
    const activeBrowsers = browsers.filter(browser => descends(browser.pid, root, parents) &&
      !descends(browser.ppid, browserRoots, parents)).length
    units += Math.max(requested ? Number(requested) : browserConcurrency, activeWorkers + activeBrowsers)
  }
  for (const row of browsers) {
    if (descends(row.pid, owned, parents) || descends(row.pid, testRoots, parents) || descends(row.ppid, browserRoots, parents)) continue
    units++
  }
  return units
}

// Acquire every unit under one election or release every partial acquisition.
// Each unit uses the existing supervisor-bound lease and dead-owner recovery.
export async function reserveCompute(config, units, budget, { snapshot = processSnapshot, agentUnits = 0 } = {}) {
  const { capacity, browserConcurrency } = config.resources
  if (!Number.isSafeInteger(units) || units <= 0 || units > capacity) throw new Error('resource request exceeds host capacity')
  const root = path.join(config.stateDir, 'locks')
  while (true) {
    budget.check()
    const reservation = await withLease(root, 'compute-admission', async () => {
      const releases = [], owned = new Set(), managed = new Map()
      try {
        // Reading a unit invokes existing lease recovery; an occupied unit
        // retains both controller and supervisor/group identities.
        let occupied = 0
        for (let i = 0; i < capacity; i++) {
          const release = await acquireLease(root, `compute-${i}`, { budget })
          if (release) releases.push(release)
          else {
            occupied++
            for (const entry of await fs.readdir(path.join(root, `compute-${i}.claims`))) {
              if (!entry.endsWith('.json')) continue
              const record = await readJson(path.join(root, `compute-${i}.claims`, entry), null)
              if (record?.job?.groupPid) {
                owned.add(record.job.groupPid)
                const existing = managed.get(record.job.groupPid) ?? { units: 0, agents: record.job.agentUnits ?? 0 }
                existing.units++; managed.set(record.job.groupPid, existing)
              }
              if (record?.job?.pid) owned.add(record.job.pid)
            }
          }
        }
        let rows
        try { rows = await snapshot(budget) } catch (error) {
          if ([142, 130].includes(error.code)) throw error
          throw new Error('resource observation unavailable')
        }
        const parents = new Map(rows.map(row => [row.pid, row.ppid]))
        for (const [group, reservation] of managed) {
          const actual = unmanagedUnits(rows.filter(row => descends(row.pid, new Set([group]), parents)), new Set(), browserConcurrency) + reservation.agents
          occupied += Math.max(0, actual - reservation.units)
        }
        if (occupied + unmanagedUnits(rows, owned, browserConcurrency) + units > capacity) return null
        const selected = releases.splice(0, units)
        const release = async () => { await Promise.all(selected.map(fn => fn())) }
        release.bindJob = async job => Promise.all(selected.map(fn => fn.bindJob({ ...job, agentUnits })))
        return release
      } finally { await Promise.all(releases.map(fn => fn())) }
    }, { waitMs: Math.ceil(budget.remaining()), pollMs: config.pollMs, budget })
    if (reservation) return reservation
    await budget.sleep(config.pollMs)
  }
}
