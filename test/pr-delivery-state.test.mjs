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
  assert.ok(results.filter(Boolean).length <= 1)
  if (!results.some(Boolean)) results[0] = await acquireLease(root, "merge-owner")
  assert.equal(await acquireLease(root, "merge-owner"), null)
  await results.find(Boolean)()
  const release = await acquireLease(root, "merge-owner")
  assert.equal(typeof release, "function")
  await release()
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
