import test from 'node:test'
import assert from 'node:assert/strict'
import * as manager from 'software-factory/design-manager'
import { layers, assessments, artifact } from '../fixtures/design-layers.mjs'

const apps = ['synthetic-task-web', 'synthetic-catalog']
const replay = view => manager.resumeDesignInterview(JSON.parse(JSON.stringify(view.interview)))
const answer = (view, value, status = 'answered') => manager.answerDesignInterview(view.interview,
  { questionId: view.question.id, answer: { status, ...(status === 'answered' ? { value } : {}) } })
function intake(projectId, entry) {
  let view = manager.startDesignInterview({ projectId, sourceRevision: 'a'.repeat(40) })
  const values = { entry, risk: 'bounded', tier: 'standard', platforms: ['web'],
    intent: 'Improve the surface for the included task', users: 'Synthetic owner', constraints: 'Synthetic only',
    includedWorkflows: ['Find and save an item'], exclusions: ['Sharing'],
    acceptanceCriteria: ['Saved item survives reload'], evidenceWindow: 'Two weeks', version: 1 }
  for (let count = 0; view.question && view.question.id !== 'layer-assessments' && count < 60; count++) {
    const id = view.question.id
    view = answer(view, id.startsWith('input:') ? artifact(id) : id.startsWith('assurance:') ? 'standard' : values[id])
  }
  assert.equal(view.question?.id, 'layer-assessments', 'all entry paths must assess all seven layers')
  return view
}
function finish(view) {
  while (view.question) {
    const id = view.question.id
    assert.ok(id.startsWith('input:') || id.startsWith('assurance:'), `unexpected extra interview: ${id}`)
    view = answer(view, id.startsWith('input:') ? artifact(id) : 'standard')
  }
  return view
}
function repair(view) {
  const current = view.diagnosis.assessments.find(a => a.layer === view.question.layer)
  const assessment = { ...current, revision: current.revision + 1, support: 'strong', criterionMet: true,
    artifacts: [artifact(`${current.layer}-new-observation`)], uncertainty: 'Resolved by supplied observation',
    question: null, dependencies: current.dependencies.map(d => ({ ...d,
      revision: view.diagnosis.assessments.find(a => a.layer === d.layer).revision })) }
  return answer(view, { response: 'Observation resolves this named uncertainty', assessment })
}

test('AW-2: every entry and sample chooses each lowest unsupported layer, persists one answer and resumes', () => {
  assert.deepEqual(manager.DESIGN_LAYERS, layers)
  for (const app of apps) for (const entry of manager.DESIGN_ENTRIES) for (const layer of layers) {
    const initial = intake(app, entry)
    const supplied = assessments(layer)
    // Multiple gaps must not route to the surface ahead of the lower layer.
    if (layer !== 'surface') Object.assign(supplied.at(-1), assessments('surface').at(-1))
    let view = answer(initial, supplied)
    assert.equal(view.question.layer, layer, `${app}/${entry}/${layer}`)
    assert.equal(view.question.uncertainty, `Unresolved ${layer} claim`)
    assert.equal(view.project, null)
    assert.deepEqual(replay(view), view)
    const before = structuredClone(view)
    view = repair(view)
    assert.equal(view.interview.trace.length, before.interview.trace.length + 1)
    assert.deepEqual(replay(view), view)
    assert.deepEqual(before.diagnosis.assessments, supplied, 'caller state remains immutable')
    assert.ok(view.question === null || view.question.layer !== layer)
    assert.deepEqual(initial.interview.trace.at(-1)?.answer.value, 1)
  }
})

test('AW-2: all supported returns only existing entry work, preserving scope, tiers and adjacent lifecycle', () => {
  for (const app of apps) for (const entry of manager.DESIGN_ENTRIES) {
    const view = finish(answer(intake(app, entry), assessments()))
    assert.equal(view.diagnosis.pendingLayer, null)
    assert.equal(view.project.stage, 'intake')
    assert.equal(view.project.tier, 'standard')
    assert.deepEqual(view.project.versionContract.includedWorkflows, ['Find and save an item'])
    assert.deepEqual(view.project.gates, [])
    assert.equal(manager.inspectDesignInitialization(view).status, 'pass')
    assert.deepEqual(replay(view), view)
  }
})

test('AW-2: dependency order accepts explicit independent decisions without inventing dependency links', () => {
  const supplied = assessments()
  supplied[2].dependencies = [{ layer: 'evidence', revision: 1 }]
  supplied[4].dependencies = [{ layer: 'domain', revision: 1 }, { layer: 'strategy', revision: 1 }]
  const original = finish(answer(intake(apps[1], 'feature'), supplied))
  const view = manager.reassessDesignLayer(original.interview,
    { ...assessments('domain')[1], revision: 2 })
  assert.deepEqual(view.diagnosis.invalidatedLayers, ['model', 'flow', 'surface'])
  assert.deepEqual(view.diagnosis.assessments[2], original.diagnosis.assessments[2])
  assert.deepEqual(view.diagnosis.assessments[3], original.diagnosis.assessments[3])
  assert.deepEqual(replay(view), view)
})

test('AW-2: partial, assumed, weak and not-started never certify support; unknown/declined retain the question', () => {
  for (const support of ['partial', 'assumed', 'weak', 'not-started']) {
    const supplied = assessments('domain', support)
    supplied[1].criterionMet = true // Even a claimed met criterion cannot upgrade assumed evidence.
    let view = answer(intake(apps[0], 'design-system'), supplied)
    const question = view.question
    for (const status of ['unknown', 'declined']) {
      view = answer(view, undefined, status)
      assert.deepEqual(view.question, question)
      assert.equal(view.project, null)
      assert.equal(view.interview.trace.at(-1).answer.status, status)
      assert.deepEqual(replay(view), view)
    }
  }
})

test('AW-2: newly accepted scope requires new layer assessments after its separate criterion and assurance', () => {
  const original = finish(answer(intake(apps[0], 'feature'), assessments()))
  let view = manager.proposeDesignScope(original.interview, { workflow: 'Archive', reason: 'Explicit bounded request' })
  view = answer(view, 'accept')
  assert.equal(view.question.id, 'scope-criteria:1')
  view = answer(view, 'Archived items remain retrievable')
  assert.equal(view.question.id, 'assurance:1')
  view = answer(view, 'standard')
  assert.equal(view.question.id, 'layer-assessments')
  assert.equal(view.project, null)
  assert.deepEqual(replay(view), view)
  const revised = assessments('domain').map(a => ({ ...a, revision: 2,
    dependencies: a.dependencies.map(d => ({ ...d, revision: 2 })) }))
  assert.throws(() => answer(view, assessments()), /revision/)
  view = answer(view, revised)
  assert.equal(view.question.layer, 'domain')
  assert.ok(JSON.stringify(view.interview).includes('Archive'))
  assert.deepEqual(original.project.versionContract.includedWorkflows, ['Find and save an item'])
})

test('AW-2: a standalone evidence event cannot bypass the answer to the pending uncertainty', () => {
  const view = answer(intake(apps[0], 'design-system'), assessments('domain'))
  const resolved = repair(view).interview.trace.at(-1).answer.value.assessment
  assert.throws(() => manager.reassessDesignLayer(view.interview, resolved), /one answer/)
  const forged = structuredClone(view.interview)
  forged.trace.push({ assessment: resolved })
  assert.throws(() => manager.resumeDesignInterview(forged), /one answer/)
  assert.deepEqual(replay(view), view)
})

test('AW-2: contradictory domain evidence invalidates transitive decisions and keeps history and artifact refs', () => {
  const original = finish(answer(intake(apps[1], 'feature'), assessments()))
  const contradiction = { ...assessments('domain')[1], revision: 2,
    artifacts: [artifact('contradictory-domain')], decision: 'Prior authority claim contradicted' }
  let view = manager.reassessDesignLayer(original.interview, contradiction)
  assert.equal(view.question.layer, 'domain')
  assert.equal(view.project, null)
  assert.deepEqual(view.diagnosis.invalidatedLayers, ['need', 'strategy', 'model', 'flow', 'surface'])
  assert.deepEqual(view.interview.trace.slice(0, -1), original.interview.trace)
  assert.deepEqual(replay(view), view)
  view = repair(view)
  assert.equal(view.question.layer, 'need', 'repairing domain must not resurrect dependent support')
  assert.match(view.question.uncertainty, /dependenc/i)
  for (const layer of ['need', 'strategy', 'model', 'flow', 'surface']) {
    assert.equal(view.question.layer, layer)
    view = repair(view)
  }
  assert.equal(view.question, null)
  assert.deepEqual(view.project, original.project)
  assert.equal(manager.inspectDesignInitialization(view).status, 'pass')
  assert.deepEqual(replay(view), view)
  assert.equal(original.diagnosis.assessments[1].revision, 1)
  assert.ok(JSON.stringify(view.interview).includes('fixture:domain-observation'))
  assert.ok(JSON.stringify(view.interview).includes('fixture:contradictory-domain'))
})

test('AW-2: explicit N/A with no applicable dependent is accepted; unjustified or depended-on N/A rejects', () => {
  const initial = intake(apps[0], 'audit')
  const supplied = assessments()
  Object.assign(supplied.at(-1), { support: 'N/A', criterionMet: false, artifacts: [], question: null,
    dependencies: [], notApplicableReason: 'Surface expression is excluded; no in-scope decision depends on it' })
  assert.equal(finish(answer(initial, supplied)).diagnosis.pendingLayer, null)
  for (const reason of [null, '', ' ']) {
    const invalid = structuredClone(supplied); invalid.at(-1).notApplicableReason = reason
    assert.throws(() => answer(initial, invalid), /N\/A/)
  }
  const depended = structuredClone(supplied)
  Object.assign(depended[1], { support: 'N/A', notApplicableReason: 'Assume domain is irrelevant',
    criterionMet: false, question: null })
  assert.throws(() => answer(initial, depended), /N\/A|depend/)
})

test('AW-2: malformed assessments, unsupported strong claims, missing layers and stale dependencies reject', () => {
  const initial = intake(apps[0], 'design-system')
  const corruptions = [
    x => x.pop(), x => x.push(x[0]), x => { x[1].layer = 'unknown' },
    x => { x[1].support = 'confident' }, x => { x[1].criterionMet = false },
    x => { x[1].artifacts = [] }, x => { x[1].artifacts[0].digest = 'unbound' },
    x => { x[1].decision = ' ' }, x => { x[1].evidenceCriterion = '' },
    x => { x[1].uncertainty = '' }, x => { x[1].confidence = 1 },
    x => { x[1].dependencies[0].revision = 9 }, x => { x[1].dependencies = null },
    x => { x[1].dependencies = [{ layer: 'surface', revision: 1 }] },
    x => { x[1].dependencies.push(x[1].dependencies[0]) },
    x => { x[1].revision = 0 }, x => { delete x[1] },
    x => { x[1].question = [{ id: 'one', prompt: 'First?' }, { id: 'two', prompt: 'Second?' }] },
    x => { x[1].support = 'weak'; x[1].question = null }
  ]
  for (const corrupt of corruptions) {
    const invalid = assessments(); corrupt(invalid)
    assert.throws(() => answer(initial, invalid))
    assert.throws(() => answer(initial, JSON.parse(JSON.stringify(invalid))))
  }
  const view = answer(initial, assessments('domain'))
  assert.throws(() => answer(view, [{ response: 'batch', assessment: assessments()[1] }]))
  assert.throws(() => answer(view, { response: 'skip', assessment: assessments()[6] }))
  assert.throws(() => answer(view, { response: 'stale', assessment: assessments()[1] }))
  assert.throws(() => manager.reassessDesignLayer(view.interview,
    { ...assessments()[4], revision: 2 }), /depend/)
})

test('AW-2: altered question, trace order, assessment revision and derived projection fail replay/inspection', () => {
  const view = finish(answer(intake(apps[0], 'feature'), assessments()))
  for (const corrupt of [
    x => { x.trace.find(e => e.question?.id === 'layer-assessments').question.prompt += ' Another question?' },
    x => { x.trace = x.trace.filter(e => e.question?.id !== 'layer-assessments') },
    x => { x.trace.find(e => e.question?.id === 'layer-assessments').answer.value[4].dependencies[0].revision = 9 },
    x => { x.trace.push({ question: { id: 'layer:surface', prompt: 'Skip domain?' }, answer: { status: 'answered', value: 'yes' } }) }
  ]) {
    const invalid = structuredClone(view.interview); corrupt(invalid)
    assert.throws(() => manager.resumeDesignInterview(invalid))
    assert.equal(manager.inspectDesignInitialization({ ...view, interview: invalid }).status, 'fail')
  }
  const forged = structuredClone(view); forged.diagnosis.assessments[1].decision = 'Forged projection'
  assert.equal(manager.inspectDesignInitialization(forged).status, 'fail')
  const pending = answer(intake(apps[0], 'feature'), assessments('domain'))
  const invalid = structuredClone(pending.interview)
  invalid.trace.push({ question: { ...pending.question, layer: 'surface' }, answer: { status: 'unknown' } })
  assert.throws(() => manager.resumeDesignInterview(invalid), /expected question/)
})
