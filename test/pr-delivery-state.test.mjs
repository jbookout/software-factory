import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acquireLease } from "../src/pr-delivery-state.mjs"

test("a lease owner still being published is busy, not malformed JSON", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-lease-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dir = path.join(root, "merge-owner")
  const originalWrite = fs.writeFile
  let observed = false
  // Pause the actual owner publication after opening/truncating its target.
  // A second caller must see BUSY throughout that real filesystem window.
  fs.writeFile = async (file, data, options) => {
    if (path.dirname(file) === dir) {
      await originalWrite(file, "", options)
      assert.equal(await acquireLease(root, "merge-owner"), null)
      observed = true
    }
    return originalWrite(file, data, options)
  }
  let release
  try { release = await acquireLease(root, "merge-owner") }
  finally { fs.writeFile = originalWrite }
  assert.equal(observed, true)
  assert.equal(typeof release, "function")
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "owner.json"))).pid, process.pid)
  await release()
})
