import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { reserveCheck } from '../src/check-admission.mjs'
import { observeCheckResources } from '../src/check-resources.mjs'
import { Deadline, waitForCondition } from '../src/deadline.mjs'

async function fixture(t, capacity = 3) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-check-admission-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, capacity, inherited: null, pollMs: 5 }
}
const queued = async (root, count) => waitForCondition(async () => {
  const files = await fs.readdir(path.join(root, 'queue'))
  return (await Promise.all(files.map(file => fs.readFile(path.join(root, 'queue', file), 'utf8').then(JSON.parse).catch(() => null))))
    .filter(row => row?.status === 'waiting').length
}, { budget: new Deadline(5000), ready: n => n === count, pollMs: 5 })

test('three heavy checks admit a fourth only after a slot is released', async t => {
  const options = await fixture(t)
  const active = await Promise.all(Array.from({ length: 3 }, () => reserveCheck(options)))
  let admitted = false
  const fourth = reserveCheck(options).then(value => { admitted = true; return value })
  await queued(options.root, 1)
  assert.equal(admitted, false)
  await active[1].release()
  const next = await fourth
  assert.equal(next.metrics.capacity, 3)
  assert.ok(next.metrics.waitMs >= 0)
  await Promise.all([active[0].release(), active[2].release(), next.release()])
})

test('waiting checks retain FIFO order while newer callers arrive', async t => {
  const options = await fixture(t, 1), active = await reserveCheck(options), order = []
  const second = reserveCheck(options).then(value => { order.push('second'); return value })
  await queued(options.root, 1)
  const third = reserveCheck(options).then(value => { order.push('third'); return value })
  await queued(options.root, 2)
  await active.release()
  const middle = await second
  assert.deepEqual(order, ['second'])
  await middle.release()
  const last = await third
  assert.deepEqual(order, ['second', 'third'])
  await last.release()
})

test('cancelling a queued owner removes its claim and the successor proceeds', async t => {
  const options = await fixture(t, 1), active = await reserveCheck(options)
  const controller = new AbortController()
  const cancelled = reserveCheck({ ...options, budget: new Deadline(5000, { signal: controller.signal }) })
  const rejection = assert.rejects(cancelled, { code: 130 })
  await queued(options.root, 1)
  controller.abort()
  await rejection
  await queued(options.root, 0)
  const next = reserveCheck(options)
  await queued(options.root, 1)
  await active.release()
  await (await next).release()
})

test('deadline expiry does not evict a live check and retires only its waiter', async t => {
  const options = await fixture(t, 1), active = await reserveCheck(options)
  await assert.rejects(reserveCheck({ ...options, budget: new Deadline(100) }), { code: 142 })
  await queued(options.root, 0)
  assert.equal((await fs.readdir(path.join(options.root, 'check-slot-0.claims'))).filter(f => f.endsWith('.json')).length, 1)
  await active.release()
})

test('dead waiting and slot owners recover without an age-based live eviction', async t => {
  const options = await fixture(t, 1)
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid
  for (const dir of ['queue', 'check-slot-0.claims']) await fs.mkdir(path.join(options.root, dir))
  await fs.writeFile(path.join(options.root, 'queue/dead.json'), JSON.stringify({ pid: dead, token: 'dead', ticket: 1, status: 'waiting' }))
  await fs.writeFile(path.join(options.root, 'check-slot-0.claims/dead.json'), JSON.stringify({ pid: dead, token: 'dead', ticket: 1 }))
  const current = await reserveCheck(options)
  assert.equal(await fs.stat(path.join(options.root, 'queue/dead.json')).catch(() => null), null)
  assert.equal(await fs.stat(path.join(options.root, 'check-slot-0.claims/dead.json')).catch(() => null), null)
  await current.release()
})

test('nested workers reuse the owned lease and cannot release the outer slot', async t => {
  const options = await fixture(t, 1), outer = await reserveCheck(options)
  const nested = await reserveCheck({ ...options, inherited: outer.env.FACTORY_CHECK_CONTEXT })
  assert.equal(nested.metrics.nested, true)
  await nested.release()
  await assert.rejects(reserveCheck({ ...options, budget: new Deadline(100) }), { code: 142 })
  await outer.release()
  await assert.rejects(reserveCheck({ ...options, inherited: outer.env.FACTORY_CHECK_CONTEXT }), /no longer owned/)
})

test('invalid inherited context and corrupt queue metadata fail closed', async t => {
  const options = await fixture(t)
  await assert.rejects(reserveCheck({ ...options, inherited: '{}' }), /capacity mismatch/)
  await fs.mkdir(path.join(options.root, 'queue'), { recursive: true })
  await fs.writeFile(path.join(options.root, 'queue/bad.json'), '{"pid":"untrusted"}')
  await assert.rejects(reserveCheck(options), /metadata is invalid/)
})

test('resource evidence counts only the owned process tree and discloses sample errors', async () => {
  const stop = observeCheckResources(10, { snapshot: async () => [[10, 1, 2, 20], [11, 10, 3, 30], [12, 11, 4, 40], [99, 1, 100, 9999]] })
  assert.deepEqual(await stop(), { samples: 1, observationErrors: 0, intervalMs: 250, peakRssKiB: 90, peakReportedCpuPercent: 9 })
  const broken = observeCheckResources(10, { snapshot: async () => { throw new Error('unavailable') } })
  assert.deepEqual(await broken(), { samples: 0, observationErrors: 1, intervalMs: 250, peakRssKiB: null, peakReportedCpuPercent: null })
})

test('all eleven requested techniques retain explicit trial and evidence requirements', async () => {
  const plan = JSON.parse(await fs.readFile(new URL('../config/ci-efficiency-trials.v1.json', import.meta.url)))
  assert.equal(plan.schema, 'factory-ci-efficiency-trials/v1')
  assert.deepEqual(plan.trials.map(row => row.id), Array.from({ length: 11 }, (_, i) => i + 1))
  for (const row of plan.trials) {
    assert.ok(['planned', 'trial', 'qualified', 'rejected'].includes(row.status))
    assert.ok(row.entrypoints.length && row.trial && row.acceptance && row.reject_if)
    if (['qualified', 'rejected'].includes(row.status)) assert.ok(row.evidence.length, 'a decision requires a retained source-bound attempt')
  }
})
