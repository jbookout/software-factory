import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const labels = ['still', 'recording', 'live', 'inspected-source', 'vendor-claim']
const scope = { userId: 'sample-owner', projectId: 'task-app', version: 1 }
const sourceRevision = 'a'.repeat(40)
async function fixture(t, overrides = {}) {
  const api = await import('../../src/design-journal.mjs')
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'design-journal-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'private')
  const journal = await api.openDesignJournal({ root, ...scope, ...overrides })
  let key = 0
  const mutate = async request => journal.execute({ ...(request.command === 'archive' ? { origin: 'captured' } : {}), ...request,
    expectedRevision: (await journal.execute({ command: 'read' })).revision, idempotencyKey: `request-${++key}` })
  const artifact = await mutate({ command: 'archive', bytes: Buffer.from('synthetic reference bytes').toString('base64') })
  return { api, dir, root, journal, mutate, artifact: artifact.artifact }
}
function reference(artifact, label = 'still') {
  return { schema: 'design-reference.v1', id: `reference-${label}`, source: {
    url: 'https://example.org/synthetic-reference', author: 'Synthetic fixture author', revision: null,
    sourceDate: '2026-10-01', inspectedAt: '2026-10-04T12:00:00Z', availability: 'available' },
  label, origin: 'captured', platform: 'web', viewport: { width: 800, height: 600 }, state: 'empty',
  artifacts: [artifact], observedProperty: 'The fixture displays an empty-list hint',
  inference: 'The hint may help users choose a next action',
  claim: { still: 'appearance', recording: 'transition', live: 'behavior', 'inspected-source': 'implementation', 'vendor-claim': 'vendor-claim' }[label],
  userDecision: 'compare', borrowedProperty: 'empty-state hierarchy', adaptation: 'Use sample task nouns',
  mismatch: 'The reference has no task persistence', rejectionTest: 'Reject if the next action cannot be found',
  reviewerOutcome: 'rejected', limits: ['Synthetic fixture; no target-build approval'],
  reuse: { status: 'link-only', license: null, permission: null },
  experiment: { hypothesis: 'Hierarchy improves discovery', failedProperty: 'next action hidden', replacement: 'visible task entry' } }
}

test('AW-5: every evidence label and rejected experiment survives cleanup, restart and SQLite restore', async t => {
  const { api, dir, root, journal, mutate, artifact } = await fixture(t)
  for (const label of labels) await mutate({ command: 'append', kind: 'reference', record: reference(artifact, label) })
  const before = await journal.execute({ command: 'read' })
  assert.equal(before.records.length, labels.length)
  const db = execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("pragma user_version").fetchone()[0])', path.join(root, 'journal.sqlite')], { encoding: 'utf8' })
  assert.equal(db.trim(), '1')
  const backupRoot = path.join(dir, 'backup')
  await journal.execute({ command: 'backup', destination: backupRoot })
  await fs.rm(root, { recursive: true })
  const restored = await api.restoreDesignJournal({ root: path.join(dir, 'restored'), backupRoot, ...scope })
  assert.deepEqual(await restored.execute({ command: 'read' }), before)
  assert.equal((await restored.readArtifact(artifact.ref)).toString(), 'synthetic reference bytes')
  const reopened = await api.openDesignJournal({ root: path.join(dir, 'restored'), ...scope })
  assert.deepEqual(await reopened.execute({ command: 'read' }), before)
  assert.equal((await fs.stat(path.join(dir, 'restored'))).mode & 0o777, 0o700)
  assert.equal((await fs.stat(path.join(dir, 'restored/journal.sqlite'))).mode & 0o777, 0o600)
})

for (const field of ['source', 'label', 'adaptation', 'rejectionTest']) test(`AW-5 rejects missing ${field} without a write`, async t => {
  const { journal, mutate, artifact } = await fixture(t)
  const record = reference(artifact)
  delete record[field]
  const before = await journal.execute({ command: 'read' })
  await assert.rejects(mutate({ command: 'append', kind: 'reference', record }), /reference/)
  assert.deepEqual(await journal.execute({ command: 'read' }), before)
})
test('AW-5 rejects missing source date and invalid inspection date', async t => {
  const { mutate, artifact } = await fixture(t)
  for (const date of [undefined, '2026-02-30']) {
    const record = reference(artifact)
    record.source.sourceDate = date
    await assert.rejects(mutate({ command: 'append', kind: 'reference', record }), /reference/)
  }
})
test('AW-5 generated still cannot be relabelled live or promoted to behavior proof', async t => {
  const { mutate } = await fixture(t)
  const { artifact } = await mutate({ command: 'archive', bytes: Buffer.from('generated example').toString('base64'), origin: 'generated' })
  const still = reference(artifact)
  still.origin = 'generated'
  await mutate({ command: 'append', kind: 'reference', record: still })
  for (const change of [{ label: 'live' }, { claim: 'behavior' }, { claim: 'target-build-approval' }]) {
    await assert.rejects(mutate({ command: 'append', kind: 'reference', record: { ...still, id: 'forged', ...change } }), /reference/)
  }
  const recording = { ...reference(artifact, 'recording'), claim: 'behavior' }
  await assert.rejects(mutate({ command: 'append', kind: 'reference', record: recording }), /reference/)
  const blocked = reference(artifact, 'live')
  blocked.source.availability = 'blocked'
  blocked.claim = 'behavior'
  await assert.rejects(mutate({ command: 'append', kind: 'reference', record: blocked }), /reference/)
})
test('AW-5 copied code/assets require exact permission and retained license', async t => {
  const { mutate, artifact } = await fixture(t)
  const record = reference(artifact)
  record.reuse.status = 'copied'
  await assert.rejects(mutate({ command: 'append', kind: 'reference', record }), /reference/)
  record.reuse.license = 'MIT (synthetic fixture)'
  record.reuse.permission = 'Synthetic author permits this exact fixture artifact'
  await mutate({ command: 'append', kind: 'reference', record })
})
test('AW-5 rejects substituted artifact bytes on append, read and backup', async t => {
  const { root, dir, journal, mutate, artifact } = await fixture(t)
  const blob = path.join(root, 'artifacts', artifact.digest)
  await fs.chmod(blob, 0o600)
  await fs.writeFile(blob, 'substituted')
  await fs.chmod(blob, 0o400)
  await assert.rejects(mutate({ command: 'append', kind: 'reference', record: reference(artifact) }), /digest/)
  await assert.rejects(journal.readArtifact(artifact.ref), /digest/)
  await assert.rejects(journal.execute({ command: 'backup', destination: path.join(dir, 'broken-backup') }), /digest/)
})
test('AW-5 users, projects and versions cannot read each other or include another scope in backup', async t => {
  const { api, root, dir, journal, mutate, artifact } = await fixture(t)
  await mutate({ command: 'append', kind: 'reference', record: reference(artifact) })
  for (const other of [{ userId: 'other-owner' }, { projectId: 'catalog-app' }, { version: 2 }]) {
    const isolated = await api.openDesignJournal({ root, ...scope, ...other })
    assert.deepEqual((await isolated.execute({ command: 'read' })).records, [])
    await assert.rejects(isolated.readArtifact(artifact.ref), /scope/)
    await assert.rejects(isolated.execute({ command: 'append', kind: 'reference', record: reference(artifact),
      expectedRevision: 0, idempotencyKey: 'steal' }), /scope/)
  }
  await assert.rejects(journal.execute({ command: 'read', projectId: 'catalog-app' }), /unknown/)
  const backupRoot = path.join(dir, 'scoped-backup')
  await journal.execute({ command: 'backup', destination: backupRoot })
  await assert.rejects(api.restoreDesignJournal({ root: path.join(dir, 'wrong-scope'), backupRoot,
    ...scope, projectId: 'catalog-app' }), /scope/)
})
test('stale revision, conflicting idempotency and immutable record ID refuse without corrupting history', async t => {
  const { journal, artifact } = await fixture(t)
  const request = { command: 'append', kind: 'reference', record: reference(artifact), expectedRevision: 1, idempotencyKey: 'first' }
  const receipt = await journal.execute(request)
  assert.deepEqual(await journal.execute(request), receipt)
  await assert.rejects(journal.execute({ ...request, record: { ...request.record, adaptation: 'changed' } }), /idempotency/)
  await assert.rejects(journal.execute({ ...request, idempotencyKey: 'stale' }), /revision/)
  await assert.rejects(journal.execute({ ...request, idempotencyKey: 'overwrite', expectedRevision: 2 }), /immutable/)
  assert.equal((await journal.execute({ command: 'read' })).revision, 2)
})
test('two processes at one revision commit exactly one atomic event', async t => {
  const { api, root, journal, artifact } = await fixture(t)
  const second = await api.openDesignJournal({ root, ...scope })
  const outcomes = await Promise.allSettled([journal, second].map((j, index) => j.execute({ command: 'append', kind: 'reference',
    record: { ...reference(artifact), id: `parallel-${index}` }, expectedRevision: 1, idempotencyKey: `parallel-${index}` })))
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1)
  assert.match(outcomes.find(r => r.status === 'rejected').reason.message, /revision/)
  const state = await journal.execute({ command: 'read' })
  assert.equal(state.revision, 2)
  assert.equal(state.records.length, 1)
  assert.equal(state.events.length, 2)
})
test('persist one answer before returning the next question; replay a retry after restart', async t => {
  const { api, root, journal, mutate } = await fixture(t)
  const started = await mutate({ command: 'start-interview', sourceRevision })
  assert.equal(started.view.question.id, 'entry')
  const response = { questionId: 'entry', answer: { status: 'answered', value: 'new-product' } }
  const request = { command: 'answer-interview', response, expectedRevision: 2, idempotencyKey: 'answer' }
  const answered = await journal.execute(request)
  assert.equal(answered.view.question.id, 'risk')
  const reopened = await api.openDesignJournal({ root, ...scope })
  assert.deepEqual(await reopened.execute(request), answered)
  assert.equal((await reopened.execute({ command: 'read' })).view.question.id, 'risk')
  await assert.rejects(reopened.execute({ ...request, idempotencyKey: 'late-answer', expectedRevision: 3 }), /pending/)
  await assert.rejects(reopened.execute({ command: 'start-interview', sourceRevision, expectedRevision: 3, idempotencyKey: 'reset' }), /already/)
})
test('reported decisions, gates and worker receipts retain limits and confer no gate authority', async t => {
  const { journal, mutate, artifact } = await fixture(t)
  const bound = { ref: artifact.ref, digest: `sha256:${artifact.digest}` }
  await mutate({ command: 'append', kind: 'decision', record: { schema: 'design-decision.v1', id: 'decision',
    sourceRevision, decision: 'Use a visible task entry', rationale: 'Empty-state discovery', alternatives: ['Hidden menu'],
    limits: ['Owner comparison only'], artifacts: [artifact] } })
  await mutate({ command: 'append', kind: 'gate', record: { gate: 'problem', status: 'pass', artifact: bound,
    reviewerId: 'reported-reviewer', evidence: [] } })
  await mutate({ command: 'append', kind: 'worker-receipt', record: { role: 'Research Specialist', makerId: 'reported-maker',
    artifact: bound, evidence: [], unresolvedQuestions: ['Does this help target users?'], confidence: 0.5, limits: ['Synthetic'] } })
  const state = await journal.execute({ command: 'read' })
  assert.equal(state.records.length, 3)
  assert.equal(state.authority, 'reported-only')
  assert.equal(state.view, null)
})
test('restore rejects incomplete/corrupt backups and never overwrites existing journals', async t => {
  const { api, dir, journal, root, artifact } = await fixture(t)
  const backupRoot = path.join(dir, 'backup')
  await journal.execute({ command: 'backup', destination: backupRoot })
  await assert.rejects(api.restoreDesignJournal({ root, backupRoot, ...scope }), /exists/)
  await fs.chmod(path.join(backupRoot, 'artifacts', artifact.digest), 0o600)
  await fs.writeFile(path.join(backupRoot, 'artifacts', artifact.digest), 'broken backup')
  await fs.chmod(path.join(backupRoot, 'artifacts', artifact.digest), 0o400)
  const target = path.join(dir, 'restored')
  await assert.rejects(api.restoreDesignJournal({ root: target, backupRoot, ...scope }), /digest/)
  await assert.rejects(fs.stat(target), /ENOENT/)
})
test('private storage rejects checkouts, public permissions, symlinks, hardlinks and path traversal', async t => {
  const { api, dir, root, journal, artifact } = await fixture(t)
  const checkout = path.join(dir, 'checkout')
  await fs.mkdir(checkout)
  await fs.writeFile(path.join(checkout, '.git'), 'gitdir: fixture')
  await assert.rejects(api.openDesignJournal({ root: path.join(checkout, 'state'), ...scope }), /Git checkout/)
  await fs.symlink(root, path.join(dir, 'alias'))
  await assert.rejects(api.openDesignJournal({ root: path.join(dir, 'alias'), ...scope }), /symlink/)
  await fs.chmod(root, 0o755)
  await assert.rejects(journal.execute({ command: 'read' }), /private/)
  await fs.chmod(root, 0o700)
  await assert.rejects(journal.readArtifact('../journal.sqlite'), /scope|reference/)
  await fs.link(path.join(root, 'artifacts', artifact.digest), path.join(dir, 'hardlink'))
  await assert.rejects(journal.readArtifact(artifact.ref), /regular|link/)
})
test('AW-5 persistent hosting stays blocked on Joe’s host/cost decision and laptop-off qualification', async t => {
  const { journal } = await fixture(t)
  const state = await journal.execute({ command: 'read' })
  assert.equal(state.hostQualification.status, 'blocked')
  assert.match(state.hostQualification.reason, /Joe.*persistent.*host.*cost.*laptop-off/i)
})
test('private backup contains only the selected scope even when another project has records', async t => {
  const { api, root, dir, journal } = await fixture(t)
  const other = await api.openDesignJournal({ root, ...scope, projectId: 'catalog-app' })
  const archived = await other.execute({ command: 'archive', bytes: Buffer.from('catalog private bytes').toString('base64'), origin: 'captured', expectedRevision: 0, idempotencyKey: 'catalog' })
  await other.execute({ command: 'append', kind: 'reference', record: { ...reference(archived.artifact), adaptation: 'Use synthetic catalog nouns' },
    expectedRevision: 1, idempotencyKey: 'catalog-reference' })
  assert.equal((await other.execute({ command: 'read' })).records[0].record.adaptation, 'Use synthetic catalog nouns')
  const backupRoot = path.join(dir, 'backup')
  await journal.execute({ command: 'backup', destination: backupRoot })
  const restored = await api.restoreDesignJournal({ root: path.join(dir, 'restore'), backupRoot, ...scope })
  const restoredOther = await api.openDesignJournal({ root: path.join(dir, 'restore'), ...scope, projectId: 'catalog-app' })
  assert.equal((await restoredOther.execute({ command: 'read' })).revision, 0)
  assert.equal((await restored.execute({ command: 'read' })).revision, 1)
  assert.deepEqual((await fs.readdir(path.join(backupRoot, 'artifacts'))), [sha('synthetic reference bytes')])
})

test('public typed journal import exposes the same command module', async () => {
  const api = await import('software-factory/design-journal')
  assert.equal(typeof api.openDesignJournal, 'function')
  assert.equal(typeof api.restoreDesignJournal, 'function')
})
test('restore detects a lost rejected record even when database checksum is updated', async t => {
  const { api, dir, journal, mutate, artifact } = await fixture(t)
  await mutate({ command: 'append', kind: 'reference', record: reference(artifact) })
  const backupRoot = path.join(dir, 'backup')
  await journal.execute({ command: 'backup', destination: backupRoot })
  execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("DROP TRIGGER immutable_records_DELETE"); c.execute("DELETE FROM records"); c.commit()', path.join(backupRoot, 'journal.sqlite')])
  const manifestPath = path.join(backupRoot, 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath))
  manifest.databaseDigest = sha(await fs.readFile(path.join(backupRoot, 'journal.sqlite')))
  await fs.chmod(manifestPath, 0o600)
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
  await fs.chmod(manifestPath, 0o400)
  const restored = path.join(dir, 'restored')
  await assert.rejects(api.restoreDesignJournal({ root: restored, backupRoot, ...scope }), /history|record|incomplete/)
  await assert.rejects(fs.stat(restored), /ENOENT/)
})
test('missing blob refuses a backup and incomplete manifest refuses restore', async t => {
  const { api, dir, root, journal, artifact } = await fixture(t)
  const backupRoot = path.join(dir, 'backup')
  await journal.execute({ command: 'backup', destination: backupRoot })
  await fs.unlink(path.join(backupRoot, 'manifest.json'))
  await assert.rejects(api.restoreDesignJournal({ root: path.join(dir, 'restored'), backupRoot, ...scope }))
  await fs.unlink(path.join(root, 'artifacts', artifact.digest))
  await assert.rejects(journal.execute({ command: 'backup', destination: path.join(dir, 'missing-blob') }))
  await assert.rejects(fs.stat(path.join(dir, 'missing-blob')), /ENOENT/)
})
test('a replaced root or symlinked artifact directory never redirects journal reads', async t => {
  const { dir, root, journal } = await fixture(t)
  await fs.rename(root, path.join(dir, 'original'))
  await fs.mkdir(root, { mode: 0o700 })
  await assert.rejects(journal.execute({ command: 'read' }), /identity/)
  await fs.rmdir(root)
  await fs.rename(path.join(dir, 'original'), root)
  await fs.rename(path.join(root, 'artifacts'), path.join(dir, 'original-artifacts'))
  await fs.symlink(path.join(dir, 'original-artifacts'), path.join(root, 'artifacts'))
  await assert.rejects(journal.execute({ command: 'read' }), /symlink/)
})

test('an archived generated artifact cannot acquire live provenance through a later record', async t => {
  const { journal, mutate } = await fixture(t)
  const { artifact } = await mutate({ command: 'archive', bytes: Buffer.from('generated concept').toString('base64'), origin: 'generated' })
  const concept = { ...reference(artifact), origin: 'generated' }
  await mutate({ command: 'append', kind: 'reference', record: concept })
  const forged = { ...reference(artifact, 'live'), id: 'forged-live', origin: 'captured' }
  await assert.rejects(mutate({ command: 'append', kind: 'reference', record: forged }), /origin|provenance/)
  assert.equal((await journal.execute({ command: 'read' })).records.length, 1)
})
