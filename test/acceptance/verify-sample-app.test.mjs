import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as verify from 'software-factory/design-verify'
import { createArtifactReader } from 'software-factory'
import { buildSampleApp, loadFeatureMap, runVerify, SAMPLE_ENGINE } from '../fixtures/verify-sample-app/verify.mjs'

// Slice 4: one Launch → Doctor → Drive → Evidence → Cleanup run on a small
// product-owned sample app. Its HTTP user-path driver is the sample's own
// check, not e2e's web engine, so the gate must still refuse it for acceptance.
const run = promisify(execFile)
const skillDir = new URL('../fixtures/verify-sample-app/verify-skill/', import.meta.url)
const revision = 'f'.repeat(40)

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-sample-'))
  const dirs = Object.fromEntries(await Promise.all(['builds', 'evidence', 'scratch'].map(async name => {
    const dir = path.join(root, name)
    await fs.mkdir(dir)
    return [name, dir]
  })))
  await fs.writeFile(path.join(dirs.scratch, 'unrelated.txt'), 'owned by someone else')
  return dirs
}
const portClosed = port => new Promise(resolve => {
  const socket = net.connect(port, '127.0.0.1')
  socket.once('connect', () => { socket.destroy(); resolve(false) })
  socket.once('error', () => resolve(true))
})
async function rows(evidence, records) {
  return Promise.all(records.map(async r => JSON.parse(await fs.readFile(path.join(evidence, r.ref), 'utf8'))))
}

test('VERIFY skill: the product feature map has an index and one valid file per user-facing feature', async () => {
  const map = await loadFeatureMap(skillDir)
  assert.deepEqual(verify.validateFeatureMap(map), [])
  assert.deepEqual(map.index.features.map(f => f.id), ['add-task'])
  const noHandles = structuredClone(map)
  noHandles.features[0].entryPoints[1].handles = []
  assert.match(verify.validateFeatureMap(noHandles).join('\n'), /handles/)
  const orphan = structuredClone(map)
  orphan.index.features.push({ id: 'export', file: 'features/export.md' })
  assert.match(verify.validateFeatureMap(orphan).join('\n'), /export has no feature file/)
  const duplicate = structuredClone(map)
  duplicate.features[0].entryPoints[1].id = 'home-form'
  assert.match(verify.validateFeatureMap(duplicate).join('\n'), /duplicate entry point home-form/)
})

test('slice 4 sample: unit tests stay green on a broken user path; VERIFY detects it and passes the repair', async () => {
  const dirs = await workspace()
  const map = await loadFeatureMap(skillDir)
  const broken = await buildSampleApp({ outDir: path.join(dirs.builds, 'broken'), revision, defect: 'skip-persist' })
  const clean = await buildSampleApp({ outDir: path.join(dirs.builds, 'clean'), revision, defect: null })
  assert.notEqual(broken.buildDigest, clean.buildDigest)
  for (const build of [broken, clean]) {
    const { NODE_TEST_CONTEXT, ...env } = process.env
    const unit = await run(process.execPath, ['--test', '--test-reporter=tap', path.join(build.dir, 'lib.unit.mjs')], { env })
    assert.match(unit.stdout, /# pass 1\n# fail 0/)
  }

  const failing = await runVerify({ build: broken, feature: map.features[0], evidenceRoot: dirs.evidence,
    scratchParent: dirs.scratch, criterionId: 'task-saved', role: 'candidate' })
  const failed = await rows(dirs.evidence, failing.records)
  assert.deepEqual(failed.map(r => [r.entryPoint, r.entryPointStatus, r.outcome]),
    [['home-form', 'exercised', 'failed'], ['quick-add', 'exercised', 'failed']])
  assert.ok(failed.every(r => r.finding === 'task missing from storage readback'))
  assert.ok(failed.every(r => r.observed.includes('list shows the task')), 'the final screen alone looks fine')

  const passing = await runVerify({ build: clean, feature: map.features[0], evidenceRoot: dirs.evidence,
    scratchParent: dirs.scratch, criterionId: 'task-saved', role: 'candidate' })
  const passed = await rows(dirs.evidence, passing.records)
  assert.deepEqual(passed.map(r => r.outcome), ['passed', 'passed'])
  for (const r of passed) {
    assert.notEqual(r.persistence.writtenValue.digest, r.persistence.independentReadback.digest)
    assert.equal(r.persistence.readbackMethod, 'read-store.mjs reads the data file in a separate process')
    assert.equal(r.binding.buildDigest, clean.buildDigest)
    assert.equal(r.binding.sourceCommit, revision)
  }

  // Cleanup removed only this run's resources; evidence outside scratch survives byte-for-byte.
  for (const result of [failing, passing]) {
    assert.equal(await portClosed(result.port), true)
    await assert.rejects(fs.stat(result.scratchDir))
  }
  assert.equal(await fs.readFile(path.join(dirs.scratch, 'unrelated.txt'), 'utf8'), 'owned by someone else')
  const read = createArtifactReader(dirs.evidence)
  for (const r of [...failing.records, ...passing.records, ...passed.flatMap(row => [...row.artifacts,
    row.persistence.writtenValue, row.persistence.independentReadback])]) {
    const bytes = await read(r.ref)
    assert.ok(bytes?.length, r.ref)
  }
})

test('slice 4 sample: Doctor blocks a stale build and a convenience run records the skipped entry point', async () => {
  const dirs = await workspace()
  const map = await loadFeatureMap(skillDir)
  const clean = await buildSampleApp({ outDir: path.join(dirs.builds, 'clean'), revision, defect: null })
  const stale = await runVerify({ build: { ...clean, buildDigest: 'e'.repeat(64) }, feature: map.features[0],
    evidenceRoot: dirs.evidence, scratchParent: dirs.scratch, criterionId: 'task-saved', role: 'candidate' })
  const staleRows = await rows(dirs.evidence, stale.records)
  assert.deepEqual(staleRows.map(r => [r.entryPointStatus, r.outcome]), [['blocked', 'blocked'], ['blocked', 'blocked']])
  assert.match(staleRows[0].observed, /doctor: running build/)
  assert.equal(await portClosed(stale.port), true)

  const skipped = await runVerify({ build: clean, feature: map.features[0], evidenceRoot: dirs.evidence,
    scratchParent: dirs.scratch, criterionId: 'task-saved', role: 'candidate', skip: ['quick-add'] })
  const skippedRows = await rows(dirs.evidence, skipped.records)
  assert.deepEqual(skippedRows.map(r => [r.entryPoint, r.entryPointStatus]), [['home-form', 'exercised'], ['quick-add', 'skipped']])
})

test('slice 4 sample: Cleanup still runs when Launch fails or times out', async () => {
  const dirs = await workspace()
  const map = await loadFeatureMap(skillDir)
  const verifyWith = (build, options = {}) => runVerify({ build, feature: map.features[0], evidenceRoot: dirs.evidence,
    scratchParent: dirs.scratch, criterionId: 'task-saved', role: 'candidate', ...options })
  const exitsDir = path.join(dirs.builds, 'exits')
  await fs.mkdir(exitsDir)
  await fs.writeFile(path.join(exitsDir, 'server.mjs'), 'process.exit(3)\n')
  await assert.rejects(verifyWith({ dir: exitsDir, revision }), /server exited 3/)
  const hangsDir = path.join(dirs.builds, 'hangs')
  await fs.mkdir(hangsDir)
  await fs.writeFile(path.join(hangsDir, 'server.mjs'),
    "import fs from 'node:fs'\nfs.writeFileSync(new URL('./pid', import.meta.url), String(process.pid))\nsetInterval(() => {}, 1000)\n")
  await assert.rejects(verifyWith({ dir: hangsDir, revision }, { launchTimeoutMs: 2000 }), /launch timed out/)
  const pid = Number(await fs.readFile(path.join(hangsDir, 'pid'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the timed-out server is not left running')
  assert.deepEqual(await fs.readdir(dirs.scratch), ['unrelated.txt'])
})

test('slice 4 sample: the gate refuses the sample HTTP driver as acceptance evidence for the clean build', async () => {
  const dirs = await workspace()
  const map = await loadFeatureMap(skillDir)
  const clean = await buildSampleApp({ outDir: path.join(dirs.builds, 'clean'), revision, defect: null })
  const result = await runVerify({ build: clean, feature: map.features[0], evidenceRoot: dirs.evidence,
    scratchParent: dirs.scratch, criterionId: 'task-saved', role: 'candidate' })
  const [first] = await rows(dirs.evidence, result.records)
  assert.equal(first.binding.engine, SAMPLE_ENGINE)
  const manifest = verify.freezeVerifyCriteria({ projectId: first.binding.projectId, version: 1,
    contract: { revision: first.binding.contractRevision, digest: first.binding.contractDigest }, featureMap: map,
    criteria: [{ id: 'task-saved', expectation: first.expected, blocking: true, evidence: 'e2e', platforms: ['web'],
      featureId: 'add-task', entryPoints: ['home-form', 'quick-add'], storedValue: true,
      defect: { broken: { id: 'skip-persist', revision: 1, digest: 'e'.repeat(64) },
        repaired: { id: 'clean', revision: 1, digest: clean.buildDigest }, expectedViolation: 'task missing from storage readback' } }],
    traps: [] })
  const target = { projectId: first.binding.projectId, version: 1,
    contract: { revision: first.binding.contractRevision, digest: first.binding.contractDigest },
    sourceCommit: revision, buildDigest: clean.buildDigest, buildConfigDigest: clean.buildConfigDigest,
    fixtures: { [first.fixture.id]: first.fixture.digest }, featureMapDigest: verify.verifyFeatureMapDigest(map),
    platforms: { web: { targetId: first.binding.targetId, engines: { e2e: verify.ACCEPTANCE_ENGINE } } },
    makers: { ids: ['sample-maker'], sessions: ['sample-session'] } }
  const gate = await verify.evaluateVerification({ manifest, featureMap: map, target, records: result.records,
    review: null, reviewKey: 'unused-review-key-0123456789abcdefgh', readArtifact: createArtifactReader(dirs.evidence),
    limits: { timeoutMs: 60_000 } })
  assert.equal(gate.gate, 'fail')
  assert.match(gate.criteria[0].reasons.join('\n'), /not the qualified acceptance engine/)
})
