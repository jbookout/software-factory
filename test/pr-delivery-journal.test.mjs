import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createDeliveryJournal } from '../src/pr-delivery-journal.mjs'
import { Deadline } from '../src/deadline.mjs'

const binding = { repo: 'fixture/repo', pr: 7, head: 'a'.repeat(40) }
async function fixture(t, onTransition) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-journal-'))
  t.after(() => fs.rename(stateDir, `${stateDir}_to_delete`))
  const config = { stateDir, repos: { [binding.repo]: {} }, commandTimeoutMs: 2000,
    pollMs: 1, retryMs: 0, queueRunsPer24h: 4 }
  return { config, journal: createDeliveryJournal(config, {
    budget: () => new Deadline(5000), onTransition }) }
}

test('journal recovers a reconciled queue attempt without repeating the delivery action', async t => {
  const { config, journal } = await fixture(t, async state => {
    if (state === 'reconciled') throw Error('synthetic controller loss')
  })
  await journal.queue.offer(binding, { note: 'fixture\nnote' })
  await journal.queue.offer(binding)
  let deliveries = 0
  await assert.rejects(journal.queue.consume(binding.repo, {
    perform: async entry => { deliveries++; assert.equal(entry.note, 'fixture note'); return { message: 'DELIVERED' } },
    hasUnresolved: async () => false
  }), /synthetic controller loss/)
  const recovered = createDeliveryJournal(config, { budget: () => new Deadline(5000) })
  const result = await recovered.queue.consume(binding.repo, { perform: async () => { deliveries++; } })
  assert.equal(result.message, 'DELIVERED')
  assert.equal(deliveries, 1)
  assert.deepEqual(await recovered.queue.summary(), { offered: 1, pending: 0, owned: 0,
    terminal: 1, orphanLeases: 0, duplicateEffectIds: 0, nextAction: 'consume-pending' })
})

test('journal reconciles a provider effect after controller loss without sending it again', async t => {
  let writes = 0, observed = null
  const { config, journal } = await fixture(t, async state => {
    if (state === 'provider:comment:returned') throw Error('synthetic controller loss')
  })
  const effect = { ...binding, action: 'comment', fields: { body: 'fixture publication' } }
  const operations = { observe: async () => observed,
    dispatch: async () => { writes++; observed = { ok: true, status: 201, value: { id: 7, body: effect.fields.body } }; return observed },
    confirmed: result => result.value?.id === 7 }
  await assert.rejects(journal.effects.execute(effect, operations), { code: 6, uncertain: true })
  const recovered = createDeliveryJournal(config, { budget: () => new Deadline(5000) })
  assert.equal((await recovered.effects.execute(effect, operations)).value.id, 7)
  assert.equal(writes, 1)
  assert.equal(await recovered.effects.hasPending(binding), false)
})

test('unresolved effects stay pending through denied observations and only confirmed refusal permits retry', async t => {
  const { journal } = await fixture(t)
  const effect = { ...binding, action: 'merge', fields: { sha: binding.head } }
  let writes = 0
  const operations = { observe: async () => null, confirmed: result => result.value?.merged === true,
    dispatch: async () => { writes++; return { ok: false, status: 422 } } }
  assert.equal((await journal.effects.execute(effect, operations)).status, 422)
  assert.equal((await journal.effects.execute(effect, operations)).status, 422)
  assert.equal(writes, 2)
  operations.dispatch = async () => { writes++; throw Object.assign(Error('synthetic lost acknowledgement'), { uncertain: true }) }
  await assert.rejects(journal.effects.execute(effect, operations), { uncertain: true })
  operations.observe = async () => { throw Error('synthetic observation refusal') }
  await assert.rejects(journal.effects.execute(effect, operations), { code: 6, uncertain: true })
  assert.equal(writes, 3)
  assert.equal(await journal.effects.hasPending(binding), true)
})

test('restored journals observe a surviving provider effect before writing', async t => {
  const { journal } = await fixture(t)
  let writes = 0
  const result = await journal.effects.execute({ ...binding, action: 'merge', fields: { sha: binding.head } }, {
    observe: async () => ({ ok: true, status: 200, value: { merged: true, sha: 'b'.repeat(40) } }),
    dispatch: async () => { writes++ }, confirmed: () => true
  })
  assert.equal(result.value.merged, true)
  assert.equal(writes, 0)
})

test('queue cancellation fences new dispatch and retires pending offers', async t => {
  const { journal } = await fixture(t)
  await journal.queue.offer(binding)
  await journal.queue.cancel(binding.repo, binding.pr, binding.head)
  let launched = false
  await assert.rejects(journal.launchFence(binding.repo, binding.pr, binding.head, () => { launched = true }),
    { code: 130, cancelled: true, uncertain: false })
  assert.equal(launched, false)
  assert.equal((await journal.queue.offer(binding)).enqueued, false)
  assert.equal((await journal.queue.summary()).terminal, 1)
})

test('wait recovery respects unchanged deterministic inputs and discovers resumable work', async t => {
  const { journal } = await fixture(t)
  const input = { head: binding.head, dependency: 'fixture' }
  const stop = { repo: binding.repo, pr: binding.pr, cause: 'source-no-progress', code: 2,
    message: 'NO-PROGRESS', resetAt: null }
  assert.equal((await journal.waits.record(binding.repo, binding.pr, input, stop)).recorded, true)
  assert.equal((await journal.waits.record(binding.repo, binding.pr, input, stop)).recorded, false)
  await assert.rejects(journal.waits.record(binding.repo, binding.pr, { ...input, budgetAvailable: true }, null), { code: 2 })
  assert.deepEqual(await journal.recoveryCandidates(), [{ repo: binding.repo, pr: binding.pr }])
  await journal.waits.record(binding.repo, binding.pr, { ...input, head: 'b'.repeat(40) }, null)
  await journal.waits.complete(binding.repo, binding.pr)
  assert.deepEqual(await journal.recoveryCandidates(), [])
})

test('repair publication retains immutable receipt before notification and recovers pending notification', async t => {
  const { config, journal } = await fixture(t)
  const record = { schema: 'factory-repair-delivery/v1', id: 'fixture-repair', ...binding,
    baseHead: binding.head, status: 'built' }
  await journal.repairs.save(record)
  let receipt
  await assert.rejects(journal.repairs.deliver(record, async file => {
    receipt = file
    assert.equal((await journal.repairs.read(binding.repo, binding.pr)).status, 'inbox_pending')
    throw Error('synthetic notification failure')
  }), /synthetic notification failure/)
  const recovered = createDeliveryJournal(config, { budget: () => new Deadline(5000) })
  assert.deepEqual(await recovered.recoveryCandidates(), [{ repo: binding.repo, pr: binding.pr, repairId: record.id }])
  const result = await recovered.repairs.deliver(await recovered.repairs.read(binding.repo, binding.pr), async file => {
    assert.equal(file, receipt)
  })
  assert.equal(result.receipt, receipt)
  assert.equal((await recovered.repairs.read(binding.repo, binding.pr)).status, 'delivered')
  await assert.rejects(recovered.repairs.retain({ ...record, status: 'different' }), /terminal repair receipt changed/)
  assert.deepEqual(await recovered.recoveryCandidates(), [])
})
