import { killOwnedGroup, ownedGroupAlive } from "./process-group.mjs"
import { Deadline, monotonicNow } from "./deadline.mjs"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

export class DeliveryError extends Error {
  constructor(message, code = 1, transient = false) {
    super(message); this.code = code; this.transient = transient
  }
}
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
export const keyFor = (repo, pr) => `${encodeURIComponent(repo)}-${pr}`
export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")) }
  catch (error) {
    if (error.code === "ENOENT") return fallback
    if (error instanceof SyntaxError) throw new DeliveryError("invalid delivery state JSON", 9)
    throw error
  }
}
// Journals are durable. Lease claims pass durable: false: owner liveness, not
// surviving a power loss, recovers them, and they churn on every contention poll.
export async function writeJson(file, value, { durable = true } = {}) {
  const temp = `${file}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  let handle
  try {
    handle = await fs.open(temp, "wx", 0o600)
    await handle.writeFile(JSON.stringify(value))
    if (durable) await handle.sync()
    await handle.close(); handle = null
    await fs.rename(temp, file)
    if (durable) {
      const directory = await fs.open(path.dirname(file), "r")
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally {
    if (handle) await handle.close()
    await fs.rm(temp, { force: true })
  }
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== "ESRCH" } }

// Each contender owns a unique record: dead-owner recovery never unlinks a
// successor's lock. A bounded bakery election retains its claim while peers
// choose tickets, so simultaneous callers cannot both withdraw before election.
export async function acquireLease(root, name, { budget } = {}) {
  budget?.check()
  const dir = path.join(root, `${name}.claims`)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const token = randomUUID(), file = path.join(dir, `${token}.json`)
  let owner = { pid: process.pid, token, ticket: 0 }
  let released = false, binding = Promise.resolve()
  const release = async () => {
    released = true
    // A write already in progress must retire before removal. Later binders
    // see revocation immediately and cannot recreate a live controller claim.
    await binding.catch(() => {})
    await fs.rm(file, { force: true })
  }
  const peers = async () => {
    const result = []
    for (const entry of await fs.readdir(dir)) {
      budget?.check()
      if (!entry.endsWith(".json") || entry === `${token}.json`) continue
      const peer = await readJson(path.join(dir, entry), null)
      if (!peer) continue
      // A supervised job keeps its slot even after its controller dies.
      const group = peer.job?.groupPid
      const groupAlive = group && ownedGroupAlive(group)
      // The independent supervisor owns elapsed expiry. A wall-clock correction
      // in persisted metadata must not terminate an active supervised mutation.
      if (groupAlive && !alive(peer.pid) && !alive(peer.job.pid)) {
        try { killOwnedGroup(group, "SIGKILL") }
        catch (error) { if (error.code !== "ESRCH") throw error }
      }
      if (alive(peer.pid) || (peer.job && alive(peer.job.pid)) || groupAlive) result.push(peer)
      else await fs.rm(path.join(dir, entry), { force: true })
    }
    return result
  }
  const claim = value => writeJson(file, value, { durable: false })
  try {
    await claim(owner)
    owner.ticket = Math.max(0, ...(await peers()).map(p => p.ticket)) + 1
    await claim(owner)
    const choosingUntil = monotonicNow() + 1000
    let contenders = await peers()
    while (contenders.some(p => p.ticket === 0)) {
      budget?.check()
      if (monotonicNow() >= choosingUntil) { await release(); return null }
      if (budget) await budget.sleep(10); else await pause(10)
      contenders = await peers()
    }
    const blocked = contenders.some(p => p.ticket < owner.ticket ||
      (p.ticket === owner.ticket && p.token < token))
    if (blocked) { await release(); return null }
    release.bindJob = (job, signal) => {
      binding = binding.then(async () => {
        if (released || signal?.aborted) throw new Error('job lease released or launch revoked')
        owner = { ...owner, job }; await claim(owner)
        return { file, token }
      })
      return binding
    }
    return release
  } catch (error) { await release(); throw error }
}
export async function withLease(root, name, fn, { waitMs = 0, pollMs = 30, budget } = {}) {
  const until = monotonicNow() + waitMs
  do {
    budget?.check()
    const release = await acquireLease(root, name, { budget })
    if (release) { try { return await fn(release) } finally { await release() } }
    if (monotonicNow() >= until) throw new DeliveryError(`BUSY: ${name} already owned`, 75)
    if (budget) await budget.sleep(pollMs); else await pause(pollMs)
  } while (true)
}

export async function reserveCodex(config, repo, pr, kind, budget = new Deadline(config.queueTimeoutMs ?? config.limits.timeoutMs, { phase: "queue" }), { beforeAdmission = async () => {}, identity } = {}) {
  const root = path.join(config.stateDir, "locks")
  const attemptId = identity?.attemptId ?? randomUUID()
  try {
    while (true) {
      budget.check()
      await beforeAdmission()
      const result = await withLease(root, "budget", async () => {
        await beforeAdmission()
        const file = path.join(config.stateDir, "usage.json")
        const usage = (await readJson(file, [])).filter(r => r.at >= Date.now() - 86400_000)
        if (usage.filter(r => r.repo === repo && r.pr === pr).length >= config.limits.runsPer24h)
          {
            const error = new DeliveryError(`BUDGET-STOP ${repo}#${pr}: runs per 24h exhausted`, 75)
            const records = usage.filter(r => r.repo === repo && r.pr === pr).sort((a, b) => a.at - b.at)
            error.resetAt = records[records.length - config.limits.runsPer24h].at + 86400_001
            error.cause = "budget-exhausted"
            throw error
          }
        for (let i = 0; i < config.limits.slots; i++) {
          const release = await acquireLease(root, `codex-slot-${i}`, { budget })
          if (release) {
            try { budget.check(); await writeJson(file, [...usage, { repo, pr, kind, attemptId, ...(identity ? { head: identity.head, effectId: identity.effectId } : {}), at: Date.now() }]) }
            catch (e) { await release(); throw e }
            return release
          }
        }
        return null
      }, { waitMs: config.commandTimeoutMs, pollMs: config.pollMs, budget })
      if (result) {
        try { budget.check(); result.attemptId = attemptId; return result }
        catch (error) { await result(); throw error }
      }
      await budget.sleep(config.pollMs)
    }
  } catch (error) {
    if (error.code !== 142) throw error
    const stop = new DeliveryError(`SLOT-STOP ${repo}#${pr}: concurrency wait timed out`, 75)
    stop.cause = "slot-wait"; stop.phase = "queue"
    throw stop
  }
}

// Projection recovery reuses admission to retire dead, unowned claim files.
// A surviving supervisor/group retains its claim and remains visible as orphaned.
export async function orphanLeaseCount(root, { recover = false, budget } = {}) {
  let count = 0
  for (const name of await fs.readdir(root).catch(error => { if (error.code === "ENOENT") return []; throw error })) {
    if (!name.endsWith(".claims")) continue
    for (const file of await fs.readdir(path.join(root, name))) {
      if (!file.endsWith(".json")) continue
      const owner = await readJson(path.join(root, name, file), null)
      if (owner && (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)) throw new DeliveryError("invalid lease owner identity", 9)
      if (owner && !alive(owner.pid)) {
        count++
        const jobAlive = owner.job?.pid && alive(owner.job.pid)
        const groupAlive = owner.job?.groupPid && ownedGroupAlive(owner.job.groupPid)
        if (recover && !jobAlive && !groupAlive) {
          const release = await acquireLease(root, name.slice(0, -7), { budget })
          if (release) await release()
          if (!await readJson(path.join(root, name, file), null)) count--
        }
      }
    }
  }
  return count
}
