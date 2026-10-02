import test from 'node:test'
import assert from 'node:assert/strict'
import * as manager from 'software-factory/design-manager'
import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'

const identity = { projectId: 'synthetic-task-web', sourceRevision: 'a'.repeat(40) }
const schema = JSON.parse(readFileSync(new URL('../schemas/design-project.schema.json', import.meta.url)))
const validateProject = new Ajv2020({ strict: true }).compile(schema)
const artifact = ref => ({ ref: `fixture:${ref}`, digest: `sha256:${'b'.repeat(64)}` })
const apps = [
  { ...identity, workflow: 'Create and complete a task', criteria: 'Completed task remains completed after reload' },
  { projectId: 'synthetic-catalog', sourceRevision: 'c'.repeat(40), workflow: 'Find and save a catalog item',
    criteria: 'Saved item is retrievable after reload' }
]
const tiers = {
  lean: ['grill', 'workflow', 'concepts', 'owner-testing', 'accessibility', 'implementation-criteria', 'post-build-review'],
  standard: ['domain-research', 'alternatives', 'interactive-prototype', 'task-evaluation', 'failure-states', 'measurable-baseline', 'decision-record'],
  'high-assurance': ['representative-users', 'privacy-threat-analysis', 'formal-accessibility', 'stronger-validation', 'staged-release', 'monitoring', 'rollback', 'independent-assurance']
}
const entryArtifacts = {
  'new-product': ['product-brief'], feature: ['feature-delta'],
  'workflow-redesign': ['current-proposed-flow'], audit: ['severity-ranked-findings'],
  'design-system': ['system-inventory'], 'platform-derivation': ['platform-mapping'],
  'concept-evaluation': ['concept-comparison'], 'post-build-refinement': ['contract-candidate-comparison'],
  'automation-interaction': ['authority-refusal-recovery-model']
}
const entryInputs = {
  'new-product': [], feature: ['existing-contract'], 'workflow-redesign': ['current-workflow'],
  audit: ['built-candidate'], 'design-system': ['current-system'], 'platform-derivation': ['source-design'],
  'concept-evaluation': ['candidate-concepts'],
  'post-build-refinement': ['built-candidate', 'accepted-design', 'operational-baseline'],
  'automation-interaction': ['authority-model']
}
function answer(view, value, status = 'answered') {
  return manager.answerDesignInterview(view.interview, { questionId: view.question.id,
    answer: { status, ...(status === 'answered' ? { value } : {}) } })
}
function complete(app, entry, tier) {
  let view = manager.startDesignInterview(app)
  const values = { entry, risk: 'bounded', tier, platforms: ['web'], intent: app.criteria,
    users: 'Synthetic owner', constraints: 'Isolated synthetic data only',
    includedWorkflows: [app.workflow], exclusions: ['Sharing'], acceptanceCriteria: [app.criteria],
    evidenceWindow: 'Two weeks of owner task use', version: 1 }
  for (let count = 0; view.question && count < 60; count++) {
    const id = view.question.id
    view = answer(view, id.startsWith('input:') ? artifact(id)
      : id.startsWith('assurance:') ? tier : values[id])
  }
  assert.equal(view.question, null, 'interview must finish')
  return view
}

test('entry interview asks one question, records one answer and resumes without a tier default', () => {
  const initial = manager.startDesignInterview(identity)
  assert.equal(initial.question.id, 'entry')
  assert.equal(initial.project, null)
  assert.equal(initial.question.prompt.split('?').length, 2)
  const next = manager.answerDesignInterview(initial.interview,
    { questionId: 'entry', answer: { status: 'answered', value: 'feature' } })
  assert.equal(initial.interview.trace.length, 0)
  assert.equal(next.interview.trace.length, 1)
  assert.equal(next.question.id, 'risk')
  assert.equal(next.project, null)
  assert.deepEqual(manager.resumeDesignInterview(JSON.parse(JSON.stringify(next.interview))), next)
  assert.throws(() => manager.answerDesignInterview(next.interview, [
    { questionId: 'risk', answer: { status: 'answered', value: 'unknown' } },
    { questionId: 'tier', answer: { status: 'answered', value: 'lean' } }
  ]), /one answer/)
})

test('both sample apps initialize every entry and tier with all required artifacts and checklist stops', () => {
  assert.deepEqual(manager.DESIGN_ENTRIES, Object.keys(entryArtifacts))
  for (const app of apps) for (const entry of Object.keys(entryArtifacts)) for (const tier of Object.keys(tiers)) {
    const view = complete(app, entry, tier)
    assert.equal(validateProject(view.project), true, JSON.stringify(validateProject.errors))
    assert.equal(view.project.entry, entry)
    assert.equal(view.project.tier, tier)
    assert.equal(view.project.stage, 'intake')
    assert.equal(view.project.status, 'active')
    assert.deepEqual(view.project.handoffs, [])
    assert.deepEqual(view.project.gates, [])
    assert.deepEqual(view.project.versionContract.includedWorkflows, [app.workflow])
    assert.deepEqual(view.project.versionContract.exclusions, ['Sharing'])
    assert.deepEqual(view.project.versionContract.acceptanceCriteria, [app.criteria])
    assert.equal(view.project.versionContract.evidenceWindow, 'Two weeks of owner task use')
    const required = Object.keys(tiers).slice(0, Object.keys(tiers).indexOf(tier) + 1).flatMap(key => tiers[key])
    for (const id of required) assert.ok(view.requirements.some(x => x.id === `tier:${id}`), `${entry}/${tier}: ${id}`)
    for (const id of entryArtifacts[entry]) assert.ok(view.requirements.some(x => x.id === `entry:${id}`), `${entry}: ${id}`)
    for (const role of manager.DESIGN_ROLES) {
      const requirement = view.requirements.find(x => x.id === `checklist:${role.role}`)
      assert.deepEqual(requirement.artifacts, role.outputs)
      assert.equal(requirement.criterion, role.rubric)
      assert.equal(requirement.stop, role.stop)
    }
    for (const gate of manager.DESIGN_GATES)
      assert.ok(view.requirements.some(x => x.id === `gate:${gate}`), `${entry}/${tier}: ${gate}`)
    assert.match(view.requirements.find(x => x.id === 'gate:build-readiness').criterion,
      /loading, empty, stale, failure, conflict, permission/)
    assert.ok(view.requirements.every(x => x.status === 'pending' && manager.DESIGN_STAGES.includes(x.stage)))
    assert.ok(view.interview.trace.every(x => !Array.isArray(x.question) && x.question.prompt.split('?').length === 2))
    assert.equal(view.interview.trace.filter(x => x.question.id === 'tier').length, 1)
    assert.equal(view.inputs.intent, app.criteria)
    assert.equal(view.inputs.users, 'Synthetic owner')
    assert.equal(view.inputs.constraints, 'Isolated synthetic data only')
    for (const input of entryInputs[entry]) {
      assert.deepEqual(view.inputs[`input:${input}`], artifact(`input:${input}`))
      assert.ok(view.interview.trace.some(e => e.question.id === `input:${input}`))
    }
    assert.match(view.requirements.find(x => x.id === 'tier:workflow').criterion,
      /normal, refusal, recovery, handoff and concurrency/)
  }
})

test('project and pending-question edits cannot change recorded answers through shared references', () => {
  const initialized = complete(apps[0], 'feature', 'standard')
  const originalTrace = structuredClone(initialized.interview.trace)
  initialized.project.versionContract.acceptanceCriteria.push('Unapproved changed criterion')
  initialized.project.platforms.push('ios')
  assert.deepEqual(initialized.interview.trace, originalTrace)
  assert.equal(manager.inspectDesignInitialization(initialized).status, 'fail')
  const proposed = manager.proposeDesignScope(complete(apps[0], 'feature', 'lean').interview,
    { workflow: 'Archive completed tasks', reason: 'Explicit request' })
  const before = structuredClone(proposed.interview.trace)
  proposed.question.expansion.before.push('Hidden scope')
  assert.deepEqual(proposed.interview.trace, before)
})

test('tier selection explains upward recommendation, included and omitted work, effort and protected risks', () => {
  let view = answer(manager.startDesignInterview(identity), 'audit')
  view = answer(view, 'unknown')
  assert.equal(view.question.id, 'tier')
  assert.equal(view.question.recommendation, 'high-assurance')
  for (const choice of view.question.choices) {
    assert.ok(choice.included.length && Array.isArray(choice.omitted) && choice.effort && choice.protectedRisks.length)
  }
  const unknown = answer(view, undefined, 'unknown')
  assert.equal(unknown.question.id, 'tier')
  assert.equal(unknown.project, null)
  assert.equal(unknown.interview.trace.at(-1).answer.status, 'unknown')
  const declined = answer(unknown, undefined, 'declined')
  assert.equal(declined.question.id, 'tier')
  assert.equal(declined.project, null)
  assert.equal(declined.interview.trace.at(-1).answer.status, 'declined')
  assert.equal(answer(declined, 'standard').question.id, 'platforms')
})

test('scope expansion is displayed, accepted separately and requires new acceptance criteria before initialization', () => {
  const initial = complete(apps[0], 'feature', 'lean')
  let view = manager.proposeDesignScope(initial.interview,
    { workflow: 'Archive completed tasks', reason: 'Owner requested a bounded addition' })
  assert.equal(view.project, null)
  assert.equal(view.question.id, 'scope-expansion')
  assert.deepEqual(view.question.expansion.before, [apps[0].workflow])
  assert.deepEqual(view.question.expansion.after, [apps[0].workflow, 'Archive completed tasks'])
  assert.equal(view.question.expansion.reason, 'Owner requested a bounded addition')
  assert.deepEqual(manager.resumeDesignInterview(JSON.parse(JSON.stringify(view.interview))), view)
  const declined = answer(view, 'decline')
  assert.deepEqual(declined.project.versionContract.includedWorkflows, [apps[0].workflow])
  assert.deepEqual(declined.project.versionContract.deferredRefinements, ['Archive completed tasks'])
  view = answer(view, 'accept')
  assert.equal(view.project, null)
  assert.equal(view.question.id, 'scope-criteria:1')
  view = answer(view, 'Archived task is retrievable from the archive after reload')
  assert.equal(view.question.id, 'assurance:1')
  assert.ok(view.question.choices.find(x => x.value === 'high-assurance').scopeImpact.length)
  view = answer(view, 'high-assurance')
  assert.equal(view.project.tier, 'lean', 'workflow assurance can exceed the project tier')
  assert.ok(view.project.versionContract.acceptanceCriteria.includes('Archived task is retrievable from the archive after reload'))
  assert.deepEqual(view.requirements.find(x => x.id === 'tier:representative-users').workflows, ['Archive completed tasks'])
  assert.deepEqual(initial.project.versionContract.includedWorkflows, [apps[0].workflow])
  assert.throws(() => manager.proposeDesignScope(initial.interview,
    { workflow: 'Sharing', reason: 'Excluded work' }), /excluded/)
})

test('initialization inspection rejects omitted critical work, batch interview, silent Lean and hidden scope expansion', () => {
  const initial = complete(apps[1], 'post-build-refinement', 'standard')
  assert.deepEqual(manager.inspectDesignInitialization(initial), { status: 'pass', errors: [] })
  const corruptions = {
    'omitted critical work': x => { x.requirements = x.requirements.filter(r => r.id !== 'tier:failure-states') },
    'lost checklist artifact': x => { x.requirements[0].artifacts.pop() },
    'lost entry artifact': x => { x.requirements = x.requirements.filter(r => !r.id.startsWith('entry:')) },
    'batch interview': x => { x.interview.trace[0].question = [x.interview.trace[0].question, x.interview.trace[1].question] },
    'batched prompt': x => { x.interview.trace[0].question.prompt += ' Which tier?' },
    'silent Lean default': x => { x.interview.trace = x.interview.trace.filter(e => e.question.id !== 'tier'); x.project.tier = 'lean' },
    'hidden scope expansion': x => { x.project.versionContract.includedWorkflows.push('Unapproved export') },
    'fabricated gate': x => { x.project.gates.push({ gate: 'problem', status: 'pass' }) },
    'mislabelled finished artifact': x => { x.requirements[0].status = 'pass' },
    'omitted critical supplied input': x => { delete x.inputs['input:built-candidate'] }
  }
  for (const [name, corrupt] of Object.entries(corruptions)) {
    const view = structuredClone(initial); corrupt(view)
    const verdict = manager.inspectDesignInitialization(view)
    assert.equal(verdict.status, 'fail', name)
    assert.ok(verdict.errors.length, name)
  }
})

test('intake carries exact-revision e2e requirements for every criterion and reconciles supplied mobile signals', () => {
  const web = complete(apps[0], 'new-product', 'lean')
  const proof = web.requirements.find(x => x.id === 'proof:criterion-e2e')
  assert.deepEqual(proof.artifacts, ['criterion-to-entry-point map', 'exact-revision e2e action/assertion/result', 'independent stored-value readback'])
  assert.match(proof.criterion, /unit\/component|direct-driver/)
  const signals = { dependencies: ['expo'], paths: [] }
  let view = manager.startDesignInterview({ ...identity, signals })
  view = answer(answer(answer(view, 'platform-derivation'), 'unknown'), 'high-assurance')
  assert.equal(view.question.id, 'platforms')
  assert.deepEqual(view.question.requiredPlatforms, ['ios', 'android'])
  assert.throws(() => answer(view, ['web']), /platform mismatch/)
  view = answer(view, ['ios', 'android'])
  const values = { intent: apps[0].criteria, users: 'Synthetic owner', constraints: 'No production data',
    includedWorkflows: [apps[0].workflow], exclusions: [], acceptanceCriteria: [apps[0].criteria],
    evidenceWindow: 'Two weeks', version: 1 }
  while (view.question) view = answer(view, view.question.id.startsWith('input:') ? artifact('source-design')
    : view.question.id.startsWith('assurance:') ? 'high-assurance' : values[view.question.id])
  const mobile = view.requirements.find(x => x.id === 'proof:mobile')
  assert.match(mobile.criterion, /each declared mobile platform/)
  assert.equal(mobile.stop, manager.MOBILE_CAPABILITY_REQUIRED)
  assert.equal(manager.evaluateMobileVerification(view.project, []).status, 'fail')
  assert.equal(manager.inspectDesignInitialization(view).status, 'pass', 'initialization does not certify mobile capability')
})

test('malformed and out-of-order answers cannot omit critical intake or rewrite interview history', () => {
  for (const sourceRevision of ['main', ['a'.repeat(40)], 42, null])
    assert.throws(() => manager.startDesignInterview({ ...identity, sourceRevision }), /invalid design interview/)
  assert.throws(() => manager.startDesignInterview({ ...identity, signals: null }), /signals/)
  let view = manager.startDesignInterview(identity)
  for (const response of [null, [], { questionId: 'entry', answer: { status: 'answered' } },
    { questionId: 'entry', answer: { status: 'answered', value: 'constructor' } },
    { questionId: 'tier', answer: { status: 'answered', value: 'lean' } },
    { questionId: 'entry', answer: { status: 'unknown', value: 'feature' } },
    { questionId: 'entry', answer: { status: 'answered', value: 'audit' }, more: 'batch' }])
    assert.throws(() => manager.answerDesignInterview(view.interview, response))
  view = answer(answer(answer(view, 'audit'), 'bounded'), 'lean')
  for (const platforms of [[], ['web', 'web'], ['watch'], 'web']) assert.throws(() => answer(view, platforms))
  view = answer(view, ['web'])
  for (const outcome of ['', ' ', {}, null, undefined]) assert.throws(() => answer(view, outcome))
  const uninitialized = manager.inspectDesignInitialization(view)
  assert.equal(uninitialized.status, 'fail')
  const finished = complete(apps[0], 'audit', 'lean')
  assert.throws(() => manager.answerDesignInterview(finished.interview,
    { questionId: 'tier', answer: { status: 'answered', value: 'lean' } }), /pending question/)
  const malformed = structuredClone(finished.interview)
  malformed.trace[1].answer.value = 'consequential'
  assert.throws(() => manager.resumeDesignInterview(malformed), /expected question/)
  assert.throws(() => manager.proposeDesignScope(view.interview,
    { workflow: 'Export', reason: 'Extra work' }), /pending interview/)
})

test('required supplied artifacts and non-overlapping scope must be explicit before initialization', () => {
  let view = manager.startDesignInterview(identity)
  const values = { entry: 'post-build-refinement', risk: 'bounded', tier: 'standard', platforms: ['web'],
    intent: apps[0].criteria, users: 'Owner', constraints: 'Synthetic only',
    includedWorkflows: [apps[0].workflow], exclusions: [], acceptanceCriteria: [apps[0].criteria],
    evidenceWindow: 'Two weeks', version: 1 }
  while (!view.question.id.startsWith('input:')) {
    if (view.question.id === 'exclusions') assert.throws(() => answer(view, [apps[0].workflow]), /included.*excluded/)
    view = answer(view, values[view.question.id])
  }
  assert.equal(view.question.id, 'input:built-candidate')
  for (const input of [null, {}, { ...artifact('candidate'), ref: ' ' }, { ...artifact('candidate'), digest: 'unbound' },
    { ...artifact('candidate'), digest: [`sha256:${'b'.repeat(64)}`] },
    { ...artifact('candidate'), extra: true }]) {
    assert.throws(() => answer(view, input), /ArtifactRef/)
  }
  const unknown = answer(view, undefined, 'unknown')
  const declined = answer(unknown, undefined, 'declined')
  assert.equal(declined.project, null)
  assert.equal(declined.question.id, 'input:built-candidate')
  assert.deepEqual(declined.interview.trace.slice(-2).map(e => e.answer.status), ['unknown', 'declined'])
})

test('public entry declarations describe the serialized interview and initialization interface', async () => {
  const { parse } = await import('@typescript-eslint/parser')
  const ast = parse(readFileSync(new URL('../src/design-manager.d.mts', import.meta.url), 'utf8'),
    { sourceType: 'module', ecmaVersion: 'latest' })
  const declarations = new Map(ast.body.map(x => [x.declaration.id?.name, x.declaration]))
  const view = complete(apps[0], 'feature', 'standard')
  for (const [name, value] of Object.entries({ DesignInterviewView: view,
    DesignInterview: view.interview, EntryRequirement: view.requirements[0] })) {
    const fields = declarations.get(name)?.body?.body
    assert.ok(fields, `${name} is declared`)
    assert.deepEqual(fields.filter(x => !x.optional).map(x => x.key.name).sort(), Object.keys(value).sort(), name)
  }
  for (const name of ['startDesignInterview', 'resumeDesignInterview', 'answerDesignInterview',
    'proposeDesignScope', 'inspectDesignInitialization']) assert.ok(declarations.has(name), name)
})
