import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Deadline, monotonicNow } from './deadline.mjs'
import { acquireLease, withLease, readJson, writeJson } from './pr-delivery-state.mjs'

const exec = promisify(execFile)
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }

async function inheritedLease(root, context, capacity) {
  let value
  try { value = JSON.parse(context) } catch { throw new Error('invalid nested check context') }
  if (value.root !== root || !/^check-slot-[0-2]\.claims$/.test(path.basename(path.dirname(value.file ?? ''))) ||
      path.dirname(path.dirname(value.file ?? '')) !== root || path.basename(value.file) !== `${value.token}.json`)
    throw new Error('invalid nested check context')
  const owner = await readJson(value.file, null)
  if (!owner || owner.token !== value.token || !alive(owner.pid)) throw new Error('nested check lease is no longer owned')
  if (owner.pid !== process.pid) {
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 2000 })
    const parents = new Map(stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)))
    const roots = new Set([owner.job?.pid, owner.job?.groupPid].filter(Boolean))
    let pid = process.pid
    const seen = new Set()
    while (pid && !roots.has(pid) && !seen.has(pid)) { seen.add(pid); pid = parents.get(pid) }
    if (!roots.has(pid)) throw new Error('nested check process is not owned by the lease')
  }
  return { release: async () => {}, bindJob: async () => [], env: { FACTORY_HEAVY_CHECK_DIR: root, FACTORY_CHECK_CONTEXT: context },
    metrics: { capacity, waitMs: 0, nested: true } }
}

export async function reserveCheck({ root = process.env.FACTORY_HEAVY_CHECK_DIR ?? path.join(os.homedir(), '.cache/software-factory/checks'),
  budget = new Deadline(3600_000, { phase: 'check-admission' }), capacity = 3,
  inherited = process.env.FACTORY_CHECK_CONTEXT, pollMs = 30 } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 3) throw new Error('check capacity must be between one and three')
  budget.check()
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  root = await fs.realpath(root)
  if (inherited) {
    if ((await readJson(path.join(root, 'capacity.json'), null))?.capacity !== capacity) throw new Error('shared check capacity mismatch')
    return inheritedLease(root, inherited, capacity)
  }
  const queue = path.join(root, 'queue')
  await fs.mkdir(queue, { recursive: true, mode: 0o700 })
  const token = randomUUID(), file = path.join(queue, `${token}.json`), began = monotonicNow()
  const election = fn => withLease(root, 'check-election', fn, { budget, waitMs: Math.ceil(budget.remaining()), pollMs })
  const rows = async () => {
    const result = [], missing = Symbol("missing queue entry")
    for (const entry of await fs.readdir(queue)) {
      if (!entry.endsWith('.json')) continue
      const record = await readJson(path.join(queue, entry), missing)
      if (record === missing) continue
      if (!record || !Number.isSafeInteger(record.pid) || record.pid < 1 || !Number.isSafeInteger(record.ticket) ||
          record.ticket < 1 || `${record.token}.json` !== entry || !['waiting', 'active'].includes(record.status))
        throw new Error('check queue metadata is invalid')
      if (alive(record.pid)) result.push(record)
      else await fs.rm(path.join(queue, entry), { force: true })
    }
    return result.sort((a, b) => a.ticket - b.ticket || a.token.localeCompare(b.token))
  }
  let slot
  try {
    await election(async () => {
      const settings = path.join(root, 'capacity.json'), current = await readJson(settings, null)
      if (current && current.capacity !== capacity) throw new Error('shared check capacity mismatch')
      if (!current) await writeJson(settings, { capacity })
      const peers = await rows()
      await writeJson(file, { pid: process.pid, token, ticket: Math.max(0, ...peers.map(row => row.ticket)) + 1, status: 'waiting' }, { durable: false })
    })
    while (!slot) {
      budget.check()
      slot = await election(async () => {
        const peers = await rows()
        if (peers.find(row => row.status === 'waiting')?.token !== token) return null
        for (let i = 0; i < capacity; i++) {
          const release = await acquireLease(root, `check-slot-${i}`, { budget })
          if (!release) continue
          try {
            await writeJson(file, { ...peers.find(row => row.token === token), status: 'active' }, { durable: false })
            const binding = await release.bindJob({ pid: process.pid })
            return { release, bindJob: release.bindJob, binding }
          } catch (error) { await release(); throw error }
        }
        return null
      })
      if (!slot) await budget.sleep(pollMs)
    }
    budget.check()
    const context = JSON.stringify({ root, ...slot.binding })
    let released = false
    return {
      release: async () => { if (!released) { released = true; await slot.release(); await fs.rm(file, { force: true }) } },
      bindJob: async (job, signal) => [await slot.bindJob(job, signal)],
      env: { FACTORY_HEAVY_CHECK_DIR: root, FACTORY_CHECK_CONTEXT: context },
      metrics: { capacity, waitMs: monotonicNow() - began, nested: false }
    }
  } catch (error) { await slot?.release(); await fs.rm(file, { force: true }); throw error }
}
