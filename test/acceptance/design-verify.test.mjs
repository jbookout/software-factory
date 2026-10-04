import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as verify from 'software-factory/design-verify'

// AW-4: synthetic store fixtures for the criterion evidence contract. These
// records exercise the gate; they are not e2e qualification receipts.
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const key = 'review-key-held-by-the-core-0123456789'
const featureMap = {
  index: { schema: 'verify-feature-map.v1', product: 'synthetic-task-web',
    features: [{ id: 'add-task', file: 'features/add-task.md' }, { id: 'task-list', file: 'features/task-list.md' }] },
  features: [
    { id: 'add-task', title: 'Add a task', entryPoints: [
      { id: 'home-form', route: '/', handles: ['form#add-task', 'input[name=title]'] },
      { id: 'quick-add', route: '/quick-add', handles: ['form#quick-add'] }],
    subFeatures: ['blank title refusal'], userRoute: ['open entry point', 'type title', 'submit'],
    observableEndState: 'the task appears in the list and survives reload', storedValues: ['task title'],
    gotchas: ['blank titles are refused on purpose'] },
    { id: 'task-list', title: 'Read the task list', entryPoints: [{ id: 'list-page', route: '/tasks', handles: ['ul#tasks'] }],
      subFeatures: ['empty state'], userRoute: ['open list'], observableEndState: 'tasks or the empty-state copy are shown',
      storedValues: [], gotchas: ['an empty list is an intended state'] }
  ]
}
const fixture = (id, seed) => ({ id, revision: 1, digest: sha(seed) })
const criteriaInput = {
  projectId: 'synthetic-task-web', version: 1, contract: { revision: 3, digest: sha('contract r3') },
  criteria: [
    { id: 'task-saved', expectation: 'a submitted task is listed and read back from storage', blocking: true,
      evidence: 'e2e', platforms: ['web'], featureId: 'add-task', entryPoints: ['home-form', 'quick-add'], storedValue: true,
      defect: { broken: fixture('add-task-drops-title', 'broken build'), repaired: fixture('add-task-repaired', 'repaired build'),
        expectedViolation: 'saved task title is empty' } },
    { id: 'focus-visible', expectation: 'keyboard focus is visible on every add-task control', blocking: true,
      evidence: 'manual', platforms: ['web'], featureId: 'add-task', entryPoints: ['home-form', 'quick-add'], storedValue: false,
      defect: { broken: fixture('focus-ring-removed', 'no focus ring'), repaired: fixture('focus-ring-restored', 'focus ring'),
        expectedViolation: 'submit button has no visible focus indicator' } },
    { id: 'empty-copy', expectation: 'an empty list explains how to add a task', blocking: false,
      evidence: 'e2e', platforms: ['web'], featureId: 'task-list', entryPoints: ['list-page'], storedValue: false,
      defect: { broken: fixture('empty-copy-missing', 'blank empty state'), repaired: fixture('empty-copy-restored', 'empty copy'),
        expectedViolation: 'empty list shows no guidance' } }
  ],
  traps: [
    { id: 'blank-title-refusal', criterionId: 'task-saved', fixture: fixture('blank-title', 'intended refusal') },
    { id: 'empty-list', criterionId: 'empty-copy', fixture: fixture('no-tasks', 'intended empty state') }
  ]
}
const buildA = { projectId: 'synthetic-task-web', version: 1, contract: { revision: 3, digest: sha('contract r3') },
  sourceCommit: 'a'.repeat(40), buildDigest: sha('build A bytes'), buildConfigDigest: sha('production config'),
  fixtures: { 'tasks-seed': sha('seed tasks') },
  platforms: { web: { engine: verify.ACCEPTANCE_ENGINE, targetId: 'chromium-headless/sample-1' } },
  makers: { ids: ['codex-maker'], sessions: ['maker-session-1'] } }

async function world({ edit = () => {}, target = buildA, reviewEdit = p => p, sign = verify.signReviewReceipt, manifestInput = criteriaInput } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-verify-'))
  const put = async (ref, content) => {
    const bytes = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content))
    await fs.writeFile(path.join(root, ref), bytes)
    return { ref, digest: sha(bytes) }
  }
  const manifest = verify.freezeVerifyCriteria({ ...manifestInput, featureMap })
  const oracles = {}
  for (const c of manifest.criteria) oracles[c.id] = await put(`oracle-${c.id}.txt`, `assert ${c.expectation}`)
  const binding = (platform = 'web') => ({ projectId: buildA.projectId, version: buildA.version,
    contractRevision: buildA.contract.revision, contractDigest: buildA.contract.digest,
    sourceCommit: buildA.sourceCommit, buildDigest: buildA.buildDigest, buildConfigDigest: buildA.buildConfigDigest,
    platform, engine: buildA.platforms.web.engine, targetId: buildA.platforms.web.targetId })
  const rows = []
  for (const c of manifest.criteria) {
    const method = c.evidence
    const base = { schema: 'design-check.v1', criterionId: c.id, binding: binding(), actor: 'synthetic owner',
      startingState: 'seeded with two tasks', steps: ['open entry', 'act', 'assert'], expected: c.expectation,
      method, oracle: oracles[c.id], finding: null, persistence: null }
    for (const entryPoint of c.entryPoints) {
      const row = { ...base, role: 'candidate', fixture: { id: 'tasks-seed', revision: 1, digest: buildA.fixtures['tasks-seed'] },
        entryPoint, entryPointStatus: 'exercised', observed: `${c.expectation} via ${entryPoint}`, outcome: 'passed',
        artifacts: [await put(`${c.id}-${entryPoint}-assertion.txt`, `passed ${c.id} ${entryPoint}`)] }
      if (c.storedValue) row.persistence = {
        writtenValue: await put(`${c.id}-${entryPoint}-ui.json`, `{"ui":"Buy milk via ${entryPoint}"}`),
        independentReadback: await put(`${c.id}-${entryPoint}-store.json`, `{"row":"Buy milk via ${entryPoint}"}`),
        readbackMethod: 'product read-only store CLI' }
      rows.push(row)
    }
    const entryPoint = c.entryPoints[0]
    rows.push({ ...base, role: 'broken', fixture: c.defect.broken, entryPoint, entryPointStatus: 'exercised',
      observed: c.defect.expectedViolation, outcome: 'failed', finding: c.defect.expectedViolation,
      artifacts: [await put(`${c.id}-broken-repro.txt`, `repro fails: ${c.defect.expectedViolation}`)] })
    rows.push({ ...base, role: 'repaired', fixture: c.defect.repaired, entryPoint, entryPointStatus: 'exercised',
      observed: c.expectation, outcome: 'passed', artifacts: [await put(`${c.id}-repaired.txt`, `repro passes ${c.id}`)] })
  }
  for (const trap of manifest.traps) {
    const c = manifest.criteria.find(item => item.id === trap.criterionId)
    rows.push({ schema: 'design-check.v1', criterionId: c.id, role: 'trap', trapId: trap.id, binding: binding(),
      fixture: trap.fixture, actor: 'synthetic owner', startingState: 'trap state', steps: ['open entry', 'assert'],
      expected: c.expectation, observed: 'intended behavior, no violation', method: c.evidence, oracle: oracles[c.id],
      entryPoint: c.entryPoints[0], entryPointStatus: 'exercised', outcome: 'passed', finding: null, persistence: null,
      artifacts: [await put(`${trap.id}-trap.txt`, `trap clean ${trap.id}`)] })
  }
  await edit(rows, { put, manifest })
  const records = []
  for (const [index, row] of rows.entries()) records.push(await put(`check-${index}.json`, row))
  const payload = reviewEdit({ schema: 'design-review.v1', reviewerId: 'claude-reviewer', sessionId: 'review-session-9',
    freshContext: { inheritedSessions: [], receivedMakerScores: false },
    targetDigest: verify.verifyTargetDigest(target), manifestDigest: manifest.digest,
    recordsRead: records.map(record => record.digest), verdict: 'pass', aggregateScore: 9.6 })
  const review = sign ? sign(payload, key) : payload
  return { manifest, featureMap, target, records, review, reviewKey: key, rows, put,
    readArtifact: ref => fs.readFile(path.join(root, ref)).catch(() => null) }
}

const evaluate = async options => verify.evaluateVerification(await world(options))
const reasons = result => result.reasons.join('\n')
const byId = (result, id) => result.criteria.find(c => c.id === id)
const rowFor = (rows, criterionId, role, entryPoint) => rows.find(r => r.criterionId === criterionId && r.role === role &&
  (!entryPoint || r.entryPoint === entryPoint))

test('AW-4 pass: frozen criteria, every entry point on the immutable build, broken/repaired oracle and independent review', async () => {
  const result = await evaluate()
  assert.equal(result.gate, 'pass', reasons(result))
  assert.deepEqual(result.criteria.map(c => [c.id, c.verdict]),
    [['task-saved', 'pass'], ['focus-visible', 'pass'], ['empty-copy', 'pass']])
  assert.equal(result.review.status, 'authenticated')
  assert.equal(result.targetDigest, verify.verifyTargetDigest(buildA))
})

test('AW-4 frozen manifest: immutable, digest-bound and every feature entry point is required', async () => {
  const manifest = verify.freezeVerifyCriteria({ ...criteriaInput, featureMap })
  assert.throws(() => { manifest.criteria[0].expectation = 'rewritten' }, TypeError)
  assert.match(manifest.digest, /^[a-f0-9]{64}$/)
  const convenient = structuredClone(criteriaInput)
  convenient.criteria[0].entryPoints = ['home-form']
  assert.throws(() => verify.freezeVerifyCriteria({ ...convenient, featureMap }), /quick-add/)
  const noDefect = structuredClone(criteriaInput)
  delete noDefect.criteria[1].defect
  assert.throws(() => verify.freezeVerifyCriteria({ ...noDefect, featureMap }), /malformed criteria/)
  const duplicated = structuredClone(criteriaInput)
  duplicated.criteria[2].id = 'task-saved'
  assert.throws(() => verify.freezeVerifyCriteria({ ...duplicated, featureMap }), /duplicate criterion/)
  // A manifest edited after freezing (expectation rewritten to match the defect) is not the frozen one.
  const w = await world()
  const forged = { ...w.manifest, criteria: w.manifest.criteria.map((c, i) => i ? c : { ...c, expectation: 'anything' }) }
  const tampered = await verify.evaluateVerification({ ...w, manifest: forged })
  assert.equal(tampered.gate, 'fail')
  assert.match(tampered.reasons.join('\n'), /manifest digest/)
})

for (const [criterionId, label] of [['task-saved', 'e2e'], ['focus-visible', 'manual'], ['empty-copy', 'non-blocking e2e']]) {
  test(`AW-4 each check must detect its broken fixture: ${label} check that passes its planted defect is disqualified`, async () => {
    const result = await evaluate({ edit: rows => Object.assign(rowFor(rows, criterionId, 'broken'),
      { outcome: 'passed', finding: null, observed: 'no violation seen' }) })
    assert.equal(byId(result, criterionId).verdict, 'fail')
    assert.match(byId(result, criterionId).reasons.join('\n'), /passed its broken fixture/)
    assert.equal(result.gate, criterionId === 'empty-copy' ? 'pass' : 'fail')
  })
}

test('AW-4 the frozen expected violation cannot be rewritten to match whatever the check found', async () => {
  const result = await evaluate({ edit: rows => Object.assign(rowFor(rows, 'task-saved', 'broken'),
    { finding: 'page title looks odd', observed: 'page title looks odd' }) })
  assert.equal(result.gate, 'fail')
  assert.match(reasons(result), /expected violation/)
})

test('AW-4 broken and repaired runs must use the same oracle as the candidate check', async () => {
  const result = await evaluate({ edit: async (rows, { put }) => {
    rowFor(rows, 'task-saved', 'repaired').oracle = await put('other-oracle.txt', 'a different, weaker assertion')
  } })
  assert.equal(result.gate, 'fail')
  assert.match(reasons(result), /oracle/)
})

test('AW-4 missing repaired or broken qualification and missing rows stay pending', async () => {
  for (const [drop, pattern] of [
    [rows => rows.splice(rows.indexOf(rowFor(rows, 'focus-visible', 'repaired')), 1), /repaired fixture/],
    [rows => rows.splice(rows.indexOf(rowFor(rows, 'focus-visible', 'broken')), 1), /broken fixture/],
    [rows => rows.splice(rows.indexOf(rowFor(rows, 'task-saved', 'candidate', 'quick-add')), 1), /missing required row.*quick-add/],
    [rows => rows.splice(rows.indexOf(rows.find(r => r.role === 'trap' && r.trapId === 'empty-list')), 1), /trap empty-list/]
  ]) {
    const result = await evaluate({ edit: drop })
    assert.equal(result.gate, 'pending', reasons(result))
    assert.match(reasons(result), pattern)
  }
})

test('AW-4 a flagged false-positive trap fails its criterion; non-bug traps stay clean', async () => {
  const result = await evaluate({ edit: rows => Object.assign(rows.find(r => r.trapId === 'blank-title-refusal'),
    { outcome: 'failed', finding: 'blank title was refused', observed: 'blank title was refused' }) })
  assert.equal(byId(result, 'task-saved').verdict, 'fail')
  assert.match(reasons(result), /trap blank-title-refusal flagged/)
  assert.equal(result.gate, 'fail')
})

test('AW-4 rejects missing expected/observed, rewritten expectations and malformed rows', async () => {
  for (const edit of [
    rows => { delete rowFor(rows, 'task-saved', 'candidate').expected },
    rows => { delete rowFor(rows, 'task-saved', 'candidate').observed },
    rows => { rowFor(rows, 'task-saved', 'candidate').observed = '' },
    rows => { rowFor(rows, 'task-saved', 'candidate').unexpected = true }
  ]) {
    const result = await evaluate({ edit })
    assert.equal(byId(result, 'task-saved').verdict, 'fail')
    assert.match(reasons(result), /malformed check record/)
  }
  const rewritten = await evaluate({ edit: rows => { rowFor(rows, 'task-saved', 'candidate').expected = 'page loads' } })
  assert.match(reasons(rewritten), /expectation differs from the frozen criterion/)
})

test('AW-4 skipped entry points never verify and blocked rows cannot pass', async () => {
  const skipped = await evaluate({ edit: rows => { rowFor(rows, 'task-saved', 'candidate', 'quick-add').entryPointStatus = 'skipped' } })
  assert.equal(skipped.gate, 'fail')
  assert.match(reasons(skipped), /skipped entry point quick-add/)
  const blocked = await evaluate({ edit: rows => Object.assign(rowFor(rows, 'task-saved', 'candidate', 'home-form'),
    { outcome: 'blocked', observed: 'auth expired before driving' }) })
  assert.equal(byId(blocked, 'task-saved').verdict, 'blocked')
  assert.equal(blocked.gate, 'blocked')
})

test('AW-4 unit/component-only, dev-loop driver and relabelled manual evidence fail user-facing criteria', async () => {
  for (const [method, pattern] of [['unit', /unit\/component/], ['component', /unit\/component/], ['driver', /dev-loop driver/]]) {
    const result = await evaluate({ edit: rows => rows.filter(r => r.criterionId === 'task-saved').forEach(r => { r.method = method }) })
    assert.equal(byId(result, 'task-saved').verdict, 'fail')
    assert.match(reasons(result), pattern)
  }
  const relabelled = await evaluate({ edit: rows => rows.filter(r => r.criterionId === 'focus-visible').forEach(r => { r.method = 'e2e' }) })
  assert.equal(byId(relabelled, 'focus-visible').verdict, 'fail')
  assert.match(reasons(relabelled), /requires manual evidence/)
  const engine = await evaluate({ edit: rows => rows.forEach(r => { r.binding.engine = 'agent-browser@1' }) })
  assert.equal(engine.gate, 'fail')
  assert.match(reasons(engine), /not the qualified acceptance engine/)
})

test('AW-4 stored values need a distinct, independently read value; two copies of one capture fail', async () => {
  const missing = await evaluate({ edit: rows => { rowFor(rows, 'task-saved', 'candidate').persistence = null } })
  assert.match(reasons(missing), /stored-value claim requires persistence proof/)
  const copied = await evaluate({ edit: async (rows, { put }) => {
    const row = rowFor(rows, 'task-saved', 'candidate')
    row.persistence.independentReadback = await put('copy-of-ui.json', '{"ui":"Buy milk via home-form"}')
  } })
  assert.match(reasons(copied), /not an independent read/)
  assert.equal(copied.gate, 'fail')
})

test('AW-4 digests bind bytes: substituted or unreadable artifacts do not pass', async () => {
  const w = await world()
  const swapped = w.rows.findIndex(r => r.role === 'candidate')
  const records = w.records.map((r, i) => i === swapped ? { ...r, digest: sha('forged label') } : r)
  const forged = await verify.evaluateVerification({ ...w, records })
  assert.equal(forged.gate, 'fail')
  assert.match(reasons(forged), /digest mismatch/)
  const unreadable = await verify.evaluateVerification({ ...w, records: [...w.records, { ref: 'missing.json', digest: sha('x') }] })
  assert.equal(unreadable.gate, 'blocked')
  assert.match(unreadable.reasons.join('\n'), /unreadable: missing.json/)
})

test('AW-4 evidence for build A never approves build B, even at the same source commit', async () => {
  for (const change of [
    { buildDigest: sha('build B bytes') },
    { buildConfigDigest: sha('debug config') },
    { fixtures: { 'tasks-seed': sha('changed seed') } },
    { contract: { revision: 4, digest: sha('contract r4') } },
    { platforms: { web: { engine: verify.ACCEPTANCE_ENGINE, targetId: 'chromium-headless/other' } } }
  ]) {
    const buildB = { ...buildA, ...change }
    assert.equal(buildB.sourceCommit, buildA.sourceCommit)
    const result = await evaluate({ target: buildB })
    assert.equal(result.gate, 'fail', JSON.stringify(change))
    for (const c of result.criteria) assert.match(c.reasons.join('\n'), /bound to another (build|fixture)|contract/)
  }
})

test('AW-4 reviewer receipts are authenticated, independent, fresh and must read the evidence', async () => {
  for (const [options, pattern] of [
    [{ sign: (payload) => ({ payload, signature: `hmac-sha256:${'0'.repeat(64)}` }) }, /review signature/],
    [{ sign: (payload) => verify.signReviewReceipt(payload, 'a-different-key-that-is-long-enough-xx') }, /review signature/],
    [{ reviewEdit: p => ({ ...p, reviewerId: 'codex-maker' }) }, /maker approves its own work/],
    [{ reviewEdit: p => ({ ...p, sessionId: 'maker-session-1' }) }, /fresh context/],
    [{ reviewEdit: p => ({ ...p, freshContext: { inheritedSessions: ['maker-session-1'], receivedMakerScores: false } }) }, /fresh context/],
    [{ reviewEdit: p => ({ ...p, freshContext: { inheritedSessions: [], receivedMakerScores: true } }) }, /maker scores/],
    [{ reviewEdit: p => ({ ...p, recordsRead: p.recordsRead.slice(1) }) }, /did not read/],
    [{ reviewEdit: p => ({ ...p, targetDigest: verify.verifyTargetDigest({ ...buildA, buildDigest: sha('B') }) }) }, /another target/]
  ]) {
    const result = await evaluate(options)
    assert.equal(result.gate, 'fail', pattern.source)
    assert.match(result.review.reasons.join('\n'), pattern)
  }
  const w = await world()
  const missing = await verify.evaluateVerification({ ...w, review: null })
  assert.equal(missing.gate, 'blocked')
  assert.match(missing.review.reasons.join('\n'), /no independent review/)
  const rejected = await evaluate({ reviewEdit: p => ({ ...p, verdict: 'fail' }) })
  assert.equal(rejected.gate, 'fail')
})

test('AW-4 an aggregate craft score and reviewer pass cannot override a failed blocking criterion', async () => {
  const result = await evaluate({ edit: rows => Object.assign(rowFor(rows, 'task-saved', 'candidate', 'quick-add'),
    { outcome: 'failed', observed: 'task missing after reload', finding: 'task missing after reload' }) })
  assert.equal(result.review.status, 'authenticated')
  assert.equal(result.gate, 'fail')
  assert.equal(byId(result, 'task-saved').verdict, 'fail')
})

test('AW-4 bounded repair: two failed rounds escalate with one question; a third automatic repair is refused', () => {
  assert.deepEqual(verify.planRepair({ failedRounds: 0, failing: ['task-saved'] }), { action: 'repair', round: 1 })
  assert.deepEqual(verify.planRepair({ failedRounds: 1, failing: ['task-saved'] }), { action: 'repair', round: 2 })
  const escalation = verify.planRepair({ failedRounds: 2, failing: ['task-saved', 'focus-visible'] })
  assert.equal(escalation.action, 'escalate')
  assert.deepEqual(escalation.diagnosis.failing, ['task-saved', 'focus-visible'])
  assert.equal(typeof escalation.question, 'string')
  assert.ok(escalation.question.endsWith('?'))
  assert.equal(verify.planRepair({ failedRounds: 3, failing: ['task-saved'] }).action, 'escalate')
  assert.deepEqual(verify.planRepair({ failedRounds: 1, failing: [] }), { action: 'done' })
  assert.throws(() => verify.planRepair({ failedRounds: -1, failing: [] }), /invalid repair history/)
})
