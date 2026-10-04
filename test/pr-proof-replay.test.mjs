import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { runProofReplay } from '../src/pr-proof-replay.mjs'

test('proof sandbox starts the actual Node runtime in its pinned worktree', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-sandbox-smoke-'))
  t.after(() => fs.rm(cwd, { recursive: true, force: true }))
  const result = await runProofReplay(['node', '-e', 'console.log("sandbox-ready")'],
    { cwd, pins: {}, timeoutMs: 5000 })
  assert.equal(result.code, 0, JSON.stringify(result))
  assert.equal(result.stdout.trim(), 'sandbox-ready')
})

test('proof sandbox cannot connect to the host loopback network', async t => {
  const server = net.createServer(socket => socket.end())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-sandbox-network-'))
  t.after(() => fs.rm(cwd, { recursive: true, force: true }))
  const script = `const s=require('node:net').connect(${server.address().port},'127.0.0.1');
    s.on('connect',()=>{console.log('escaped');s.destroy();process.exitCode=1});
    s.on('error',()=>console.log('network-isolated'));
    s.setTimeout(1000,()=>{console.log('network-isolated');s.destroy()})`
  const result = await runProofReplay(['node', '-e', script], { cwd, pins: {}, timeoutMs: 5000 })
  assert.equal(result.code, 0, JSON.stringify(result))
  assert.equal(result.stdout.trim(), 'network-isolated')
})

test('proof sandbox permits scratch in the proof tree and refuses sibling files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-sandbox-files-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const cwd = path.join(root, 'proof')
  await fs.mkdir(cwd)
  const outside = path.join(root, 'outside')
  await fs.writeFile(outside, 'private-canary')
  const script = `const fs=require('node:fs');fs.writeFileSync('scratch','ok');
    try{fs.readFileSync(${JSON.stringify(outside)});process.exit(31)}catch{};
    try{fs.writeFileSync(${JSON.stringify(outside + '.write')},'escape');process.exit(32)}catch{};
    console.log(fs.readFileSync('scratch','utf8'))`
  const result = await runProofReplay(['node', '-e', script], { cwd, pins: {}, timeoutMs: 5000 })
  assert.equal(result.code, 0, JSON.stringify(result))
  assert.equal(result.stdout.trim(), 'ok')
  assert.equal(await fs.readFile(outside, 'utf8'), 'private-canary')
  await assert.rejects(fs.access(outside + '.write'))
})
