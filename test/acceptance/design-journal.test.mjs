import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { canonicalJson, canonicalDigest } from '../../src/canonical.mjs'
import { assessments } from '../fixtures/design-layers.mjs'

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
  const { journal, mutate, artifact } = await fixture(t)
  const before = await journal.execute({ command: 'read' })
  for (const date of [undefined, '2026-02-30']) {
    const record = reference(artifact)
    record.source.sourceDate = date
    await assert.rejects(mutate({ command: 'append', kind: 'reference', record }), /reference/)
  }
  for (const inspectedAt of [undefined, '2026-02-30T12:00:00Z', '2026-10-04T25:00:00Z', '2026-10-04']) {
    const record = reference(artifact)
    record.source.inspectedAt = inspectedAt
    await assert.rejects(mutate({ command: 'append', kind: 'reference', record }), /reference/)
    assert.deepEqual(await journal.execute({ command: 'read' }), before)
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

test('public journal import exposes the same command module', async () => {
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

const helper = path.resolve('src/design-journal-store.py')
const python = (code, args = [], options = {}) => execFileSync('python3', ['-c', code, ...args], { encoding: 'utf8', ...options })
const decision = (artifact, id, rationale = 'Synthetic comparison') => ({ schema: 'design-decision.v1', id,
  sourceRevision, decision: 'Use a visible task entry', rationale, alternatives: ['Hidden menu'],
  limits: ['Synthetic'], artifacts: [artifact] })
async function roundtrip({ api, root, dir, journal }, name) {
  const before = await journal.execute({ command: 'read' })
  const reopened = await api.openDesignJournal({ root, ...scope })
  assert.deepEqual(await reopened.execute({ command: 'read' }), before)
  const backupRoot = path.join(dir, `backup-${name}`)
  await journal.execute({ command: 'backup', destination: backupRoot })
  const restored = await api.restoreDesignJournal({ root: path.join(dir, `restore-${name}`), backupRoot, ...scope })
  assert.deepEqual(await restored.execute({ command: 'read' }), before)
  return restored
}

test('oversized record refuses before commit and keeps accepted history replayable and restorable', async t => {
  const f = await fixture(t)
  const before = await f.journal.execute({ command: 'read' })
  await assert.rejects(f.mutate({ command: 'append', kind: 'decision',
    record: decision(f.artifact, 'oversized', 'x'.repeat(9 * 1024 * 1024)) }), /budget|limit|size|large/)
  assert.deepEqual(await f.journal.execute({ command: 'read' }), before)
  assert.equal((await f.journal.execute({ command: 'archive', bytes: Buffer.from('synthetic reference bytes').toString('base64'),
    origin: 'captured', expectedRevision: 0, idempotencyKey: 'request-1' })).revision, 1)
  await roundtrip(f, 'oversized')
})
test('cumulative growth refuses before stranding either scope or exceeding database/output budgets', async t => {
  const f = await fixture(t)
  const other = await f.api.openDesignJournal({ root: f.root, ...scope, projectId: 'catalog-app' })
  let last, refused = false
  for (let i = 0; i < 30; i++) {
    last = await f.journal.execute({ command: 'read' })
    const request = { command: 'append', kind: 'decision', record: decision(f.artifact, `growth-${i}`, 'é'.repeat(350 * 1024)),
      expectedRevision: last.revision, idempotencyKey: `growth-${i}` }
    try { await f.journal.execute(request) } catch (error) {
      assert.match(error.message, /budget|limit|size|large|full/)
      refused = true
      assert.deepEqual(await f.journal.execute({ command: 'read' }), last)
      break
    }
    assert.ok((await fs.stat(path.join(f.root, 'journal.sqlite'))).size <= 16 * 1024 * 1024)
  }
  assert.ok(refused, 'bounded store must refuse cumulative growth')
  assert.equal((await other.execute({ command: 'read' })).revision, 0)
  await other.execute({ command: 'archive', bytes: 'eA==', origin: 'captured', expectedRevision: 0, idempotencyKey: 'other' })
  await roundtrip(f, 'growth')
})

for (const change of ['replace-root', 'public-permissions']) test(`lock wait detects ${change} before accessing history`, async t => {
  const { root, dir } = await fixture(t)
  const identity = JSON.parse(python('import runpy,json,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps(m["run"](json.loads(sys.argv[2]))))',
    [helper, JSON.stringify({ op: 'open', root, scope })]))
  const holder = spawn('python3', ['-u', '-c', 'import os,fcntl,sys; fd=os.open(sys.argv[1],os.O_RDONLY); fcntl.flock(fd,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()', root])
  t.after(() => holder.kill())
  await once(holder.stdout, 'data')
  const reader = spawn('python3', ['-u', '-c', `import runpy,json,sys,fcntl
m=runpy.run_path(sys.argv[1]); original=fcntl.flock
def lock(fd, mode):
 print('waiting',file=sys.stderr,flush=True); original(fd,mode)
fcntl.flock=lock
try: print(json.dumps(m['run'](json.loads(sys.argv[2]))))
except Exception as e: print(json.dumps({'error':str(e)})); sys.exit(1)`, helper, JSON.stringify({ op: 'read', root, scope, identity })])
  t.after(() => reader.kill())
  let output = ''
  reader.stdout.on('data', bytes => { output += bytes })
  const exited = once(reader, 'close')
  await once(reader.stderr, 'data')
  if (change === 'replace-root') {
    await fs.rename(root, path.join(dir, 'original'))
    const { openDesignJournal } = await import('../../src/design-journal.mjs')
    await openDesignJournal({ root, ...scope })
  } else await fs.chmod(root, 0o755)
  holder.stdin.end()
  assert.equal((await exited)[0], 1, output)
  assert.match(JSON.parse(output).error, /identity|private/)
})

for (const change of ['missing', 'replaced']) test(`a ${change} database cannot reset existing history or idempotency`, async t => {
  const f = await fixture(t)
  await fs.rename(path.join(f.root, 'journal.sqlite'), path.join(f.dir, 'saved.sqlite'))
  if (change === 'replaced') {
    const empty = await f.api.openDesignJournal({ root: path.join(f.dir, 'empty'), ...scope })
    await empty.execute({ command: 'read' })
    await fs.copyFile(path.join(f.dir, 'empty/journal.sqlite'), path.join(f.root, 'journal.sqlite'))
  }
  await assert.rejects(f.journal.execute({ command: 'read' }), /database|identity|missing|ENOENT/)
  await assert.rejects(f.journal.execute({ command: 'archive', bytes: 'eA==', origin: 'captured',
    expectedRevision: 0, idempotencyKey: 'request-1' }), /database|identity|missing|ENOENT/)
  await assert.rejects(f.api.openDesignJournal({ root: f.root, ...scope }), /database|identity|missing|ENOENT/)
})

test('actual process death after partial blob write leaves no final digest and identical retry recovers', async t => {
  const f = await fixture(t)
  const command = { command: 'archive', bytes: Buffer.from('interrupted artifact bytes').toString('base64'),
    origin: 'captured', expectedRevision: 1, idempotencyKey: 'interrupted' }
  const { bytes, ...metadata } = command
  const value = sha(Buffer.from(bytes, 'base64'))
  const request = { op: 'commit', root: f.root, scope, request: command,
    requestText: canonicalJson({ ...metadata, artifactDigest: value }), requestDigest: canonicalDigest(command), refs: [] }
  assert.throws(() => python(`import runpy,json,sys,os,stat
m=runpy.run_path(sys.argv[1]); sync=os.fsync
def die(fd):
 info=os.fstat(fd)
 if stat.S_IMODE(info.st_mode)==0o400 and info.st_size>0:
  os.ftruncate(fd,3); sync(fd); os._exit(73)
 sync(fd)
os.fsync=die
m['run'](json.loads(sys.argv[2]))`, [helper, JSON.stringify(request)]), error => error.status === 73)
  assert.equal((await f.journal.execute({ command: 'read' })).revision, 1)
  await assert.rejects(fs.stat(path.join(f.root, 'artifacts', value)), /ENOENT/)
  const receipt = await f.journal.execute(command)
  assert.equal(receipt.revision, 2)
  assert.equal((await f.journal.readArtifact(receipt.artifact.ref)).toString(), 'interrupted artifact bytes')
  assert.deepEqual(await f.journal.execute(command), receipt)
  await roundtrip(f, 'interrupted')
})

async function corruptDecision(backupRoot) {
  python(`import sqlite3,json,hashlib,sys
p=sys.argv[1]; c=sqlite3.connect(p+'/journal.sqlite')
for table in ('records','events'):
 c.execute('DROP TRIGGER immutable_'+table+'_UPDATE')
def encode(v): return json.dumps(v,sort_keys=True,separators=(',',':'))
def sha(s): return hashlib.sha256(s.encode()).hexdigest()
r=c.execute('SELECT payload FROM records').fetchone(); record=json.loads(r[0]); record['rationale']=''; text=encode(record)
c.execute('UPDATE records SET payload=?,digest=?',(text,sha(text)))
e=c.execute("SELECT request FROM events WHERE revision=2").fetchone(); req=json.loads(e[0]); req['record']=record; text=encode(req)
c.execute('UPDATE events SET request=?,request_text_digest=?,request_digest=? WHERE revision=2',(text,sha(text),sha(text))); c.commit(); c.close()`, [backupRoot])
  const manifestPath = path.join(backupRoot, 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath))
  manifest.databaseDigest = sha(await fs.readFile(path.join(backupRoot, 'journal.sqlite')))
  await fs.chmod(manifestPath, 0o600)
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
  await fs.chmod(manifestPath, 0o400)
}
test('restore snapshots caller options and binds semantic inspection to the installed snapshot', async t => {
  const f = await fixture(t)
  await f.mutate({ command: 'append', kind: 'decision', record: decision(f.artifact, 'decision') })
  const good = path.join(f.dir, 'good'), bad = path.join(f.dir, 'bad')
  await f.journal.execute({ command: 'backup', destination: good })
  await f.journal.execute({ command: 'backup', destination: bad })
  await corruptDecision(bad)
  const invalidRoot = path.join(f.dir, 'invalid')
  await assert.rejects(f.api.restoreDesignJournal({ root: invalidRoot, backupRoot: bad, ...scope }), /decision/)
  await assert.rejects(fs.stat(invalidRoot), /ENOENT/)
  const options = { root: path.join(f.dir, 'restored'), backupRoot: good, ...scope }
  const pending = f.api.restoreDesignJournal(options)
  options.backupRoot = bad
  options.root = invalidRoot
  const restored = await pending
  assert.deepEqual(await restored.execute({ command: 'read' }), await f.journal.execute({ command: 'read' }))
  await assert.rejects(fs.stat(invalidRoot), /ENOENT/)
})
test('journal artifact schema has one definition used by both record kinds', async () => {
  const schema = JSON.parse(await fs.readFile('schemas/design-journal.schema.json'))
  for (const kind of ['reference', 'decision'])
    assert.deepEqual(schema.$defs[kind].properties.artifacts.items, { $ref: '#/$defs/artifact' })
})

const boundArtifact = artifact => ({ ...artifact, digest: `sha256:${artifact.digest}` })
const boundAssessments = (artifact, ...args) => assessments(...args).map(row => ({ ...row, artifacts: [boundArtifact(artifact)] }))
async function completeInterview(f) {
  let { view } = await f.mutate({ command: 'start-interview', sourceRevision })
  const values = { entry: 'new-product', risk: 'bounded', tier: 'lean', platforms: ['web'],
    intent: 'Complete and retain a task', users: 'Synthetic owner', constraints: 'Synthetic data only',
    includedWorkflows: ['Complete a task'], exclusions: ['Sharing'], acceptanceCriteria: ['Completion survives reload'],
    evidenceWindow: 'Two weeks', version: 1 }
  for (let count = 0; view.question && count < 60; count++) {
    const id = view.question.id
    const value = id.startsWith('input:') ? boundArtifact(f.artifact)
      : id.startsWith('assurance:') ? 'lean' : id === 'layer-assessments' ? boundAssessments(f.artifact) : values[id]
    if (id === 'version') {
      const before = await f.journal.execute({ command: 'read' })
      await assert.rejects(f.mutate({ command: 'answer-interview', response: { questionId: id,
        answer: { status: 'answered', value: 2 } } }), /version.*scope/)
      assert.deepEqual(await f.journal.execute({ command: 'read' }), before)
    }
    const request = { command: 'answer-interview', response: { questionId: id, answer: { status: 'answered', value } },
      expectedRevision: (await f.journal.execute({ command: 'read' })).revision, idempotencyKey: `intake-${id}` }
    const receipt = await f.journal.execute(request)
    const reopened = await f.api.openDesignJournal({ root: f.root, ...scope })
    assert.deepEqual(await reopened.execute(request), receipt)
    assert.deepEqual((await reopened.execute({ command: 'read' })).view, receipt.view)
    view = receipt.view
  }
  assert.equal(view.question, null)
  assert.equal(view.project.versionContract.version, scope.version)
  return view
}
for (const answer of ['decline', 'accept']) test(`scope ${answer} persists its decision, version and registered inputs through restart/restore`, async t => {
  const f = await fixture(t)
  await completeInterview(f)
  const proposal = { command: 'propose-scope', proposal: { workflow: 'Archive', reason: 'Explicit owner request' } }
  const proposed = await f.mutate(proposal)
  assert.equal(proposed.view.question.id, 'scope-expansion')
  await roundtrip(f, `pending-${answer}`)
  let { view } = await f.mutate({ command: 'answer-interview', response: { questionId: 'scope-expansion',
    answer: { status: 'answered', value: answer } } })
  if (answer === 'accept') for (const value of ['Archived tasks remain retrievable', 'lean', boundAssessments(f.artifact, null, 'weak', 2)]) {
    ({ view } = await f.mutate({ command: 'answer-interview', response: { questionId: view.question.id,
      answer: { status: 'answered', value } } }))
  }
  assert.equal(view.question, null)
  assert.equal(view.project.versionContract.includedWorkflows.includes('Archive'), answer === 'accept')
  assert.deepEqual(view.project.versionContract.deferredRefinements, answer === 'decline' ? ['Archive'] : [])
  await roundtrip(f, `complete-${answer}`)
})
test('dependency reassessment persists invalidation and rejects unregistered observations atomically', async t => {
  const f = await fixture(t)
  const initial = await completeInterview(f)
  const before = await f.journal.execute({ command: 'read' })
  const contradiction = boundAssessments(f.artifact, 'domain')[1]
  contradiction.revision = 2
  await assert.rejects(f.mutate({ command: 'reassess-layer', assessment: { ...contradiction,
    artifacts: [{ ref: `sha256:${'b'.repeat(64)}`, digest: `sha256:${'b'.repeat(64)}` }] } }), /registered|scope/)
  assert.deepEqual(await f.journal.execute({ command: 'read' }), before)
  const { view } = await f.mutate({ command: 'reassess-layer', assessment: contradiction })
  assert.equal(view.question.layer, 'domain')
  assert.equal(view.project, null)
  assert.deepEqual(view.diagnosis.invalidatedLayers, ['need', 'strategy', 'model', 'flow', 'surface'])
  assert.deepEqual(view.interview.trace.slice(0, -1), initial.interview.trace)
  await roundtrip(f, 'reassessment')
})
test('evidence binding and invalid evidence refuse atomically; accepted proof survives restart and restore', async t => {
  const f = await fixture(t)
  const artifact = f.artifact
  const record = { schema: 'design-check.v1', criterionId: 'saved-task', role: 'candidate',
    binding: { projectId: scope.projectId, version: scope.version, contractRevision: 1, contractDigest: sha('contract'),
      sourceCommit: sourceRevision, buildDigest: sha('build'), buildConfigDigest: sha('config'), platform: 'web',
      engine: 'synthetic-check', targetId: 'sample' }, fixture: { id: 'sample', revision: 1, digest: sha('fixture') },
    actor: 'Synthetic owner', startingState: 'Empty list', steps: ['Add task', 'Reload'], expected: 'Task retained',
    observed: 'Task retained', method: 'e2e', oracle: artifact, entryPoint: 'task-form', entryPointStatus: 'exercised',
    outcome: 'passed', finding: null, artifacts: [artifact], persistence: { writtenValue: artifact,
      independentReadback: artifact, readbackMethod: 'Synthetic independent read' } }
  const before = await f.journal.execute({ command: 'read' })
  for (const invalid of [{ ...record, binding: { ...record.binding, projectId: 'catalog-app' } },
    { ...record, binding: { ...record.binding, version: 2 } }, { ...record, observed: '' },
    { ...record, artifacts: [] }, { ...record, oracle: { ref: `sha256:${'c'.repeat(64)}`, digest: 'c'.repeat(64) } }]) {
    await assert.rejects(f.mutate({ command: 'append', kind: 'evidence', record: invalid }), /evidence|scope|registered/)
    assert.deepEqual(await f.journal.execute({ command: 'read' }), before)
  }
  await f.mutate({ command: 'append', kind: 'evidence', record })
  assert.deepEqual((await f.journal.execute({ command: 'read' })).records[0].record, record)
  const restored = await roundtrip(f, 'evidence')
  assert.equal((await restored.readArtifact(artifact.ref)).toString(), 'synthetic reference bytes')
})
test('journal declarations accept supported commands and reject missing bindings and scope injection', () => {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--noEmit', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--types', 'node', 'typecheck/design-journal-consumer.mts'],
  { encoding: 'utf8', stdio: 'pipe' })
})

test('replacing the root pathname after acquisition cannot redirect file access', async t => {
  const f = await fixture(t)
  const replacement = path.join(f.dir, 'replacement')
  await f.api.openDesignJournal({ root: replacement, ...scope })
  const identity = JSON.parse(python('import runpy,json,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps(m["run"](json.loads(sys.argv[2]))))',
    [helper, JSON.stringify({ op: 'open', root: f.root, scope })]))
  const result = JSON.parse(python(`import runpy,json,sys,os
m=runpy.run_path(sys.argv[1]); g=m['run'].__globals__; original=g['connect']; root=sys.argv[3]
def connect(p,**kwargs):
 os.rename(root,root+'-original'); os.rename(sys.argv[4],root)
 return original(p,**kwargs)
g['connect']=connect
print(json.dumps(m['run'](json.loads(sys.argv[2]))))`,
  [helper, JSON.stringify({ op: 'read', root: f.root, scope, identity }), f.root, replacement]))
  assert.equal(result.revision, 1, 'file access stays relative to the locked original directory')
  await assert.rejects(f.journal.execute({ command: 'read' }), /identity/)
})
test('restore refuses changed snapshot bytes after inspection before creating a destination', async t => {
  const f = await fixture(t)
  await f.mutate({ command: 'append', kind: 'decision', record: decision(f.artifact, 'decision') })
  const backupRoot = path.join(f.dir, 'backup')
  await f.journal.execute({ command: 'backup', destination: backupRoot })
  const inspection = JSON.parse(python('import runpy,json,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps(m["run"](json.loads(sys.argv[2]))))',
    [helper, JSON.stringify({ op: 'inspect-backup', backupRoot, scope })]))
  await corruptDecision(backupRoot)
  const root = path.join(f.dir, 'restored')
  assert.throws(() => python(`import runpy,json,sys
m=runpy.run_path(sys.argv[1])
try: m['run'](json.loads(sys.argv[2]))
except Exception as e: print(str(e),file=sys.stderr); sys.exit(1)`,
  [helper, JSON.stringify({ op: 'restore', root, backupRoot, scope, databaseDigest: inspection.databaseDigest })]),
  error => /changed after semantic inspection/.test(error.stderr))
  await assert.rejects(fs.stat(root), /ENOENT/)
})

test('unsupported SQLite deserialization refuses before opening a store that cannot restore', async t => {
  const { dir } = await fixture(t)
  const root = path.join(dir, 'unsupported')
  assert.throws(() => python(`import runpy,json,sys,sqlite3
m=runpy.run_path(sys.argv[1]); sqlite3.Connection=type('UnsupportedConnection',(),{})
try: m['run'](json.loads(sys.argv[2]))
except Exception as e: print(str(e),file=sys.stderr); sys.exit(1)`,
    [helper, JSON.stringify({ op: 'open', root, scope })]), error => /deserializ|Python 3.11/.test(error.stderr))
  await assert.rejects(fs.stat(root), /ENOENT/)
})

test('concurrent first opens initialize one fresh precreated private directory', async t => {
  const f = await fixture(t)
  const root = path.join(f.dir, 'fresh')
  await fs.mkdir(root, { mode: 0o700 })
  const handles = await Promise.all([f.api.openDesignJournal({ root, ...scope }), f.api.openDesignJournal({ root, ...scope })])
  for (const handle of handles) assert.equal((await handle.execute({ command: 'read' })).revision, 0)
  const request = { command: 'archive', bytes: 'eA==', origin: 'captured', expectedRevision: 0, idempotencyKey: 'first' }
  const receipt = await handles[0].execute(request)
  assert.deepEqual(await handles[1].execute(request), receipt)
})
