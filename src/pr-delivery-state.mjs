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

// Atomic directory leases. Reapers serialize and re-read the current owner;
// this avoids deleting a new owner's lease while recovering a dead process.
export async function acquireLease(root, name) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const dir = path.join(root, name), reaper = `${dir}.reaper`
  try { await fs.access(reaper); return null } catch (e) { if (e.code !== "ENOENT") throw e }
  try {
    await fs.mkdir(dir, { mode: 0o700 })
    await fs.writeFile(path.join(dir, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 })
    return () => fs.rm(dir, { recursive: true, force: true })
  } catch (e) { if (e.code !== "EEXIST") throw e }
  try { await fs.mkdir(reaper) } catch (e) { if (e.code === "EEXIST") return null; throw e }
  try {
    const owner = await readJson(path.join(dir, "owner.json"), null)
    const stat = await fs.stat(dir).catch(e => { if (e.code !== "ENOENT") throw e })
    // Allow time for the winning mkdir to publish its owner.
    if (stat && ((owner && !alive(owner.pid)) || (!owner && Date.now() - stat.mtimeMs > 5000)))
      await fs.rm(dir, { recursive: true, force: true })
  } finally { await fs.rm(reaper, { recursive: true, force: true }) }
  return null
}
export async function withLease(root, name, fn, { waitMs = 0, pollMs = 30 } = {}) {
  const until = Date.now() + waitMs
  do {
    const release = await acquireLease(root, name)
    if (release) { try { return await fn() } finally { await release() } }
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
