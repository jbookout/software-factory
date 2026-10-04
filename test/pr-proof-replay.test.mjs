import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runProofReplay } from '../src/pr-proof-replay.mjs'

test('proof sandbox starts the actual Node runtime in its pinned worktree', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-sandbox-smoke-'))
  t.after(() => fs.rm(cwd, { recursive: true, force: true }))
  const result = await runProofReplay(['node', '-e', 'console.log("sandbox-ready")'],
    { cwd, pins: {}, timeoutMs: 5000 })
  assert.equal(result.code, 0, JSON.stringify(result))
  assert.equal(result.stdout.trim(), 'sandbox-ready')
})
