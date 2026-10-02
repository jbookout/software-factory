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
// successor's lock. Ticket publication and election implement a nonblocking
// bakery mutex; callers that encounter a choosing/live earlier peer retry.
export async function acquireLease(root, name) {
  const dir = path.join(root, `${name}.claims`)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const token = randomUUID(), file = path.join(dir, `${token}.json`)
  let owner = { pid: process.pid, token, ticket: 0 }
  const release = () => fs.rm(file, { force: true })
  const peers = async () => {
    const result = []
    for (const entry of await fs.readdir(dir)) {
      if (!entry.endsWith(".json") || entry === `${token}.json`) continue
      const peer = await readJson(path.join(dir, entry), null)
      if (!peer) continue
      // A supervised job keeps its slot even after its controller dies.
      const group = peer.job?.groupPid
      const groupAlive = group && alive(process.platform === "win32" ? group : -group)
      if (groupAlive && (Date.now() >= peer.job.deadline || (!alive(peer.pid) && !alive(peer.job.pid)))) {
        try { process.kill(process.platform === "win32" ? group : -group, "SIGKILL") }
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
    const blocked = (await peers()).some(p => p.ticket === 0 || p.ticket < owner.ticket ||
      (p.ticket === owner.ticket && p.token < token))
    if (blocked) { await release(); return null }
    release.bindJob = async job => {
      owner = { ...owner, job }; await writeJson(file, owner)
      return { file, token }
    }
    return release
  } catch (error) { await release(); throw error }
}
export async function withLease(root, name, fn, { waitMs = 0, pollMs = 30 } = {}) {
  const until = Date.now() + waitMs
  do {
    const release = await acquireLease(root, name)
    if (release) { try { return await fn(release) } finally { await release() } }
    if (Date.now() >= until) throw new DeliveryError(`BUSY: ${name} already owned`, 75)
    await pause(pollMs)
  } while (true)
}

export async function reserveCodex(config, repo, pr, kind) {
  const root = path.join(config.stateDir, "locks"), until = Date.now() + config.limits.timeoutMs
  while (true) {
    const result = await withLease(root, "budget", async () => {
      const file = path.join(config.stateDir, "usage.json")
      const usage = (await readJson(file, [])).filter(r => r.at >= Date.now() - 86400_000)
      if (usage.filter(r => r.repo === repo && r.pr === pr).length >= config.limits.runsPer24h)
        throw new DeliveryError(`BUDGET-STOP ${repo}#${pr}: runs per 24h exhausted`, 75)
      for (let i = 0; i < config.limits.slots; i++) {
        const release = await acquireLease(root, `codex-slot-${i}`)
        if (release) {
          try { await writeJson(file, [...usage, { repo, pr, kind, at: Date.now() }]) }
          catch (e) { await release(); throw e }
          return release
        }
      }
      return null
    }, { waitMs: config.commandTimeoutMs, pollMs: config.pollMs })
    if (result) return result
    if (Date.now() >= until) throw new DeliveryError(`SLOT-STOP ${repo}#${pr}: concurrency wait timed out`, 75)
    await pause(config.pollMs)
  }
}
