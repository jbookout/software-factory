import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acquireLease, withLease } from "../src/pr-delivery-state.mjs"

for (const name of ["budget", "merge-owner", "queue-state"]) test(`dead ${name} and reaper recover without a second call`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-lease-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, name))
  await fs.writeFile(path.join(root, name, "owner.json"), JSON.stringify({ pid: 2147483647 }))
  await fs.mkdir(path.join(root, `${name}.reaper`))
  const old = new Date(Date.now() - 10000)
  await fs.utimes(path.join(root, `${name}.reaper`), old, old)
  assert.equal(await withLease(root, name, () => "acquired"), "acquired")
})

test("concurrent live claimants never both acquire and release is owner-specific", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-lease-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const results = await Promise.all([acquireLease(root, "merge-owner"), acquireLease(root, "merge-owner")])
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(await acquireLease(root, "merge-owner"), null)
  await results.find(Boolean)()
  const release = await acquireLease(root, "merge-owner")
  assert.equal(typeof release, "function")
  await release()
})

test("zero-wait election keeps one owner when a choosing peer publishes before withdrawal", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-lease-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const published = new Map(), tickets = []
  const deferred = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
  }
  const bothChoosing = deferred(), bothTickets = deferred()
  const choosingObserved = deferred(), earlierObserved = deferred()
  let lower, higher
  const rename = fs.rename.bind(fs), readFile = fs.readFile.bind(fs), rm = fs.rm.bind(fs)
  t.mock.method(fs, "rename", async (from, to) => {
    if (!to.startsWith(root)) return rename(from, to)
    const owner = JSON.parse(await readFile(from, "utf8"))
    if (owner.ticket === 0) {
      await rename(from, to)
      published.set(to, owner)
      if (published.size === 2) {
        [lower, higher] = [...published.keys()].sort()
        bothChoosing.resolve()
      }
      await bothChoosing.promise
    } else {
      tickets.push(owner.ticket)
      if (tickets.length === 2) bothTickets.resolve()
      await bothTickets.promise
      // Both chose ticket 1. The higher token stays in choosing until the
      // lower token has read its ticket 0 during election.
      if (to === higher) await choosingObserved.promise
      await rename(from, to)
      published.set(to, owner)
    }
  })
  t.mock.method(fs, "readFile", async (file, ...args) => {
    if (!published.has(file)) return readFile(file, ...args)
    const snapshot = JSON.stringify(published.get(file))
    if (file === higher && published.get(lower).ticket === 1 && published.get(higher).ticket === 0)
      choosingObserved.resolve()
    if (file === lower && published.get(higher).ticket === 1) earlierObserved.resolve()
    return snapshot
  })
  t.mock.method(fs, "rm", async (file, ...args) => {
    // Hold the lower token's withdrawal until the higher token has observed
    // its earlier claim. The old election makes both contenders give up.
    if (file === lower) await earlierObserved.promise
    await rm(file, ...args)
    published.delete(file)
  })
  const results = await Promise.all([acquireLease(root, "merge-owner"), acquireLease(root, "merge-owner")])
  assert.deepEqual(tickets, [1, 1])
  assert.equal(results.filter(Boolean).length, 1, "a live, ownerless lease must elect one contender")
  assert.equal(await acquireLease(root, "merge-owner"), null, "an elected owner excludes another caller")
  await results.find(Boolean)()
  assert.deepEqual(await fs.readdir(path.join(root, "merge-owner.claims")), [])
})
test("a dead published claimant is recovered in a zero-wait acquisition", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-lease-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dir = path.join(root, "merge-owner.claims")
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, "dead.json"), JSON.stringify({pid:2147483647,token:"dead",ticket:1}))
  assert.equal(await withLease(root, "merge-owner", () => "recovered"), "recovered")
  assert.deepEqual(await fs.readdir(dir), [])
})

test("a stalled live choosing peer returns busy within a bounded election", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-lease-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dir = path.join(root, "merge-owner.claims")
  await fs.mkdir(dir)
  const file = path.join(dir, "choosing.json")
  const owner = { pid: process.pid, token: "choosing", ticket: 0 }
  await fs.writeFile(file, JSON.stringify(owner))
  const started = Date.now()
  await assert.rejects(withLease(root, "merge-owner", () => assert.fail("choosing peer still owns its claim")), { code: 75 })
  assert.ok(Date.now() - started < 2000, "a stalled chooser must not hang zero-wait callers")
  assert.deepEqual(await fs.readdir(dir), ["choosing.json"])
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), owner)
})
