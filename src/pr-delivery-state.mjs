import { killOwnedGroup, ownedGroupAlive } from "./process-group.mjs"
import { Deadline } from "./deadline.mjs"
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
  catch (error) { if (error.code === "ENOENT") return fallback; throw error }
}
export async function writeJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 })
  await fs.rename(temp, file)
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
  const release = () => fs.rm(file, { force: true })
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
  try {
    await writeJson(file, owner)
    owner.ticket = Math.max(0, ...(await peers()).map(p => p.ticket)) + 1
    await writeJson(file, owner)
    const choosingUntil = Date.now() + 1000
    let contenders = await peers()
    while (contenders.some(p => p.ticket === 0)) {
      budget?.check()
      if (Date.now() >= choosingUntil) { await release(); return null }
      if (budget) await budget.sleep(10); else await pause(10)
      contenders = await peers()
    }
    const blocked = contenders.some(p => p.ticket < owner.ticket ||
      (p.ticket === owner.ticket && p.token < token))
    if (blocked) { await release(); return null }
    release.bindJob = async job => {
      owner = { ...owner, job }; await writeJson(file, owner)
      return { file, token }
    }
    return release
  } catch (error) { await release(); throw error }
}
export async function withLease(root, name, fn, { waitMs = 0, pollMs = 30, budget } = {}) {
  const until = Date.now() + waitMs
  do {
    budget?.check()
    const release = await acquireLease(root, name, { budget })
    if (release) { try { return await fn(release) } finally { await release() } }
    if (Date.now() >= until) throw new DeliveryError(`BUSY: ${name} already owned`, 75)
    if (budget) await budget.sleep(pollMs); else await pause(pollMs)
  } while (true)
}

export async function reserveCodex(config, repo, pr, kind, budget = new Deadline(config.queueTimeoutMs ?? config.limits.timeoutMs, { phase: "queue" })) {
  const root = path.join(config.stateDir, "locks")
  try {
    while (true) {
      budget.check()
      const result = await withLease(root, "budget", async () => {
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
            try { budget.check(); await writeJson(file, [...usage, { repo, pr, kind, at: Date.now() }]) }
            catch (e) { await release(); throw e }
            return release
          }
        }
        return null
      }, { waitMs: config.commandTimeoutMs, pollMs: config.pollMs, budget })
      if (result) {
        try { budget.check(); return result }
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

// All recovery writers use the same record. Reading eligibility is advisory;
// callers still take the PR lease and reserve the budget at dispatch time.
export async function deliveryWait(config, repo, pr, input, stop = null) {
  return withLease(path.join(config.stateDir, "locks"), `wait-${keyFor(repo, pr)}`, async () => {
    const file = path.join(config.stateDir, "waits", `${keyFor(repo, pr)}.json`)
    const prior = await readJson(file, null)
    if (stop) {
      const record = { schema: "factory-delivery-wait/v1", status: "suspended", ...input, ...stop }
      if (prior?.status === "suspended" && JSON.stringify(prior) === JSON.stringify(record)) return { ...prior, recorded: false }
      await writeJson(file, record)
      return { ...record, recorded: true }
    }
    if (!prior || prior.status !== "suspended") return null
    const changed = prior.head !== input.head || prior.dependency !== input.dependency
    const budgetOpen = prior.cause === "budget-exhausted" && input.budgetAvailable
    // Slot waits retry admission; reserveCodex remains the atomic arbiter.
    // Capacity signals cannot reopen a deterministic source/dependency stop.
    if (prior.cause === "slot-wait" && !changed) return null
    const budgetReset = prior.cause === "budget-exhausted" && prior.resetAt && Date.now() >= prior.resetAt
    if (changed || budgetOpen || budgetReset) {
      await writeJson(file, { ...prior, status: "resumable" })
      return null
    }
    const error = new DeliveryError(prior.message, prior.code)
    error.wait = prior
    throw error
  }, { waitMs: config.commandTimeoutMs, pollMs: config.pollMs })
}

export async function completeDeliveryWait(config, repo, pr) {
  return withLease(path.join(config.stateDir, "locks"), `wait-${keyFor(repo, pr)}`, async () => {
    const file = path.join(config.stateDir, "waits", `${keyFor(repo, pr)}.json`)
    const prior = await readJson(file, null)
    if (prior) await writeJson(file, { ...prior, status: "complete" })
  }, { waitMs: config.commandTimeoutMs, pollMs: config.pollMs })
}
