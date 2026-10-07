import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Deadline, waitForCondition } from '../src/deadline.mjs'

test('actual check entrypoints share three slots across Git worktrees and cancel only their queued request', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-check-worktrees-'))
  const repo = path.join(root, 'source'), second = path.join(root, 'second'), state = path.join(root, 'state'), events = path.join(root, 'events.jsonl')
  await fs.mkdir(repo)
  execFileSync('git', ['init', '-q', repo])
  await fs.writeFile(path.join(repo, 'work.test.mjs'), `import test from 'node:test';import fs from 'node:fs/promises';
test('bounded check fixture',async()=>{
const id=process.env.CHECK_FIXTURE_ID;
await fs.appendFile(process.env.CHECK_FIXTURE_EVENTS,JSON.stringify({id,phase:'start'})+'\\n');
while(!await fs.access(process.env.CHECK_FIXTURE_RELEASE+'/'+id).then(()=>true,()=>false))await new Promise(r=>setTimeout(r,5));
await fs.appendFile(process.env.CHECK_FIXTURE_EVENTS,JSON.stringify({id,phase:'end'})+'\\n');
});`)
  execFileSync('git', ['-C', repo, 'add', 'work.test.mjs'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'])
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', '-q', second])
  const releases = path.join(root, 'release')
  await fs.mkdir(releases)
  const children = []
  const runner = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url))
  const launch = (id, cwd) => {
    const env = { ...process.env, FACTORY_HEAVY_CHECK_DIR: state, CHECK_FIXTURE_ID: id, CHECK_FIXTURE_EVENTS: events, CHECK_FIXTURE_RELEASE: releases }
    delete env.FACTORY_CHECK_CONTEXT;delete env.NODE_TEST_CONTEXT
    const child = spawn(process.execPath, [runner, 'node', 'work.test.mjs'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const row = { child, output: '', error: '', finished: false }
    child.stdout.on('data', data => { row.output += data });child.stderr.on('data', data => { row.error += data })
    row.done = new Promise(resolve => child.on('close', code => { row.finished = true;resolve(code) }))
    children.push(row);return row
  }
  t.after(async () => {
    for (const row of children) if (!row.finished) row.child.kill('SIGTERM')
    await Promise.all(children.map(row => row.done))
    await fs.rm(root, { recursive: true, force: true })
  })
  const readEvents = async () => (await fs.readFile(events, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const wait = (probe, ready) => waitForCondition(probe, { ready, pollMs: 5, budget: new Deadline(10000) })
  const active = [launch('one', repo), launch('two', second), launch('three', repo)]
  await wait(readEvents, rows => rows.filter(row => row.phase === 'start').length === 3)
  const cancelled = launch('cancelled', second)
  const waitQueued = async () => {
    const files = await fs.readdir(path.join(state, 'queue'))
    const rows = await Promise.all(files.map(file => fs.readFile(path.join(state, 'queue', file), 'utf8').then(JSON.parse).catch(() => null)))
    return rows.some(row => row?.status === 'waiting')
  }
  await wait(waitQueued, value => value)
  cancelled.child.kill('SIGTERM')
  assert.equal(await cancelled.done, 130)
  assert.equal((await readEvents()).some(row => row.id === 'cancelled'), false)
  const fourth = launch('four', second)
  await wait(waitQueued, value => value)
  assert.equal((await readEvents()).some(row => row.id === 'four'), false)
  await fs.writeFile(path.join(releases, 'one'), '')
  await wait(readEvents, rows => rows.some(row => row.id === 'four' && row.phase === 'start'))
  for (const id of ['two', 'three', 'four']) await fs.writeFile(path.join(releases, id), '')
  for (const row of [...active, fourth]) {
    assert.equal(await row.done, 0, row.error)
    const receipt = JSON.parse(row.output.trim())
    assert.equal(receipt.metrics.capacity, 3)
    assert.equal(receipt.metrics.nested, false)
    assert.ok(receipt.metrics.resources.samples + receipt.metrics.resources.observationErrors > 0)
  }
  let current = 0, maximum = 0
  for (const row of await readEvents()) { current += row.phase === 'start' ? 1 : -1;maximum = Math.max(maximum, current) }
  assert.equal(maximum, 3)
  assert.equal(current, 0)
  t.diagnostic(JSON.stringify({ worktrees: 2, completedChecks: 4, cancelledQueuedChecks: 1, maximumActiveChecks: maximum }))
})
