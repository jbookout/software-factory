// Pure development-time contracts. No dispatch, persistence or acceptance authority.
import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { isDeepStrictEqual } from 'node:util'

const projectSchema = JSON.parse(readFileSync(new URL('../schemas/design-project.schema.json', import.meta.url)))
const projectAjv = new Ajv2020({ strict: true }).addSchema(projectSchema)
const schemaRef = pointer => ({ $ref: `${projectSchema.$id}#/${pointer}` })
const validateEvidence = projectAjv.compile(schemaRef('$defs/evidence'))
const validateProject = projectAjv.getSchema(projectSchema.$id)
const validateArtifact = projectAjv.compile(schemaRef('$defs/artifact'))
const validateProjectId = projectAjv.compile(schemaRef('properties/projectId'))
const validateSourceRevision = projectAjv.compile(schemaRef('properties/sourceRevision'))
const validateSignalStrings = projectAjv.compile({ type: 'array',
  items: schemaRef('$defs/versionContract/properties/includedWorkflows/items') })
const sharedAnswerValidators = Object.fromEntries([
  ...['entry', 'tier', 'platforms'].map(id => [id, `properties/${id}`]),
  ...['version', 'includedWorkflows', 'exclusions', 'acceptanceCriteria', 'evidenceWindow']
    .map(id => [id, `$defs/versionContract/properties/${id}`])
].map(([id, pointer]) => [id, projectAjv.compile(schemaRef(pointer))]))
const validateScopeCriterion = projectAjv.compile(schemaRef('$defs/versionContract/properties/acceptanceCriteria/items'))

export const DESIGN_STAGES = Object.freeze([
  "grill",
  "intake",
  "research",
  "define",
  "explore",
  "prototype",
  "test",
  "decide",
  "build-orchestration",
  "implementation-verification",
  "measure",
  "refine"
])

export const DESIGN_TIERS = Object.freeze([
  "lean",
  "standard",
  "high-assurance"
])

export const DESIGN_STATIONS = Object.freeze(['research', 'define', 'design', 'prove', 'ship'])
export const PROJECT_PLATFORMS = Object.freeze(['web', 'ios', 'android', 'desktop'])

const stageStations = Object.freeze([
  'define', 'define', 'research', 'define', 'design', 'design', 'prove', 'design',
  'ship', 'prove', 'prove', 'define'
])
const gateStations = Object.freeze([
  'define', 'define', 'design', 'prove', 'design', 'ship', 'prove', 'prove', 'ship'
])

export const DESIGN_GATES = Object.freeze([
  "problem",
  "workflow",
  "concept",
  "interaction",
  "system",
  "build-readiness",
  "implementation-fidelity",
  "operational-evidence",
  "version-closure"
])

export const EVIDENCE_STRENGTHS = Object.freeze([
  "target-user-observation",
  "representative-user-testing",
  "domain-expert-feedback",
  "owner-task-testing",
  "heuristic-accessibility",
  "competitor-pattern-research",
  "simulated-critique"
])

export const DESIGN_ENTRIES = Object.freeze([
  "new-product",
  "feature",
  "workflow-redesign",
  "audit",
  "design-system",
  "platform-derivation",
  "concept-evaluation",
  "post-build-refinement",
  "automation-interaction"
])

export const MODEL_MODES = Object.freeze([
  "fast",
  "thorough",
  "specialist",
  "best-available",
  "efficient-eco"
])

export const DESIGN_ROLES = Object.freeze([
  {
    "role": "Design Manager",
    "inputs": [
      "state",
      "tier",
      "scope",
      "evidence",
      "version contract"
    ],
    "outputs": [
      "routing",
      "assignments",
      "progress rail",
      "gate decisions",
      "escalations",
      "continuity"
    ],
    "rubric": "Every stage has owner, artifact, evidence standard and next state",
    "stop": "Stop hidden scope expansion"
  },
  {
    "role": "Research Specialist",
    "inputs": [
      "problem",
      "domain",
      "users",
      "factual questions"
    ],
    "outputs": [
      "primary sources",
      "pattern inventory",
      "evidence quality",
      "gaps"
    ],
    "rubric": "Source facts and label inference",
    "stop": "Stop unsupported factual claims"
  },
  {
    "role": "Product/UX Strategist",
    "inputs": [
      "intent",
      "research",
      "business constraints"
    ],
    "outputs": [
      "groups",
      "jobs",
      "outcomes",
      "hypotheses",
      "exclusions",
      "measures"
    ],
    "rubric": "Observable outcomes",
    "stop": "Stop unbounded feature scope"
  },
  {
    "role": "Workflow Architect",
    "inputs": [
      "job",
      "records",
      "failure history",
      "constraints"
    ],
    "outputs": [
      "current/proposed flows",
      "states",
      "ownership",
      "exceptions"
    ],
    "rubric": "Normal, refusal, recovery, handoff, concurrency",
    "stop": "Stop missing critical paths"
  },
  {
    "role": "Information Architect",
    "inputs": [
      "jobs",
      "content",
      "terms",
      "retrieval needs"
    ],
    "outputs": [
      "navigation",
      "hierarchy",
      "labels",
      "findability",
      "cross-surface model"
    ],
    "rubric": "Predictable homes and operating language",
    "stop": "Stop ambiguous authority/home"
  },
  {
    "role": "Interaction Designer",
    "inputs": [
      "accepted flow",
      "authority",
      "platforms"
    ],
    "outputs": [
      "controls",
      "forms",
      "transitions",
      "disclosure",
      "feedback",
      "recovery"
    ],
    "rubric": "Consequence/state/authority visible",
    "stop": "Stop dangerous ambiguity"
  },
  {
    "role": "Prototype Specialist",
    "inputs": [
      "concepts",
      "devices",
      "test questions"
    ],
    "outputs": [
      "cheapest behaviorally adequate prototype"
    ],
    "rubric": "Answers declared questions",
    "stop": "Stop production claims"
  },
  {
    "role": "Visual-System Designer",
    "inputs": [
      "brand",
      "components",
      "accessibility",
      "platforms"
    ],
    "outputs": [
      "type",
      "color",
      "spacing",
      "components",
      "tokens",
      "themes",
      "hierarchy"
    ],
    "rubric": "Consistent, distinctive, readable, reusable",
    "stop": "Stop unjustified generic styling"
  },
  {
    "role": "Accessibility Specialist",
    "inputs": [
      "flows",
      "prototypes",
      "components",
      "candidate"
    ],
    "outputs": [
      "criteria",
      "manual checks",
      "assistive tests",
      "defects",
      "remediation"
    ],
    "rubric": "Evidence for declared target",
    "stop": "Stop uncovered critical workflow/state"
  },
  {
    "role": "Usability/Evaluation Specialist",
    "inputs": [
      "hypotheses",
      "candidate",
      "participants",
      "limits"
    ],
    "outputs": [
      "task scripts",
      "observation protocol",
      "metrics",
      "severity",
      "limits"
    ],
    "rubric": "Measures outcomes without coaching",
    "stop": "Stop simulated evidence labeled as users"
  },
  {
    "role": "Adversarial Reviewer",
    "inputs": [
      "artifact",
      "criteria",
      "evidence",
      "risks"
    ],
    "outputs": [
      "assumptions",
      "contradictions",
      "failures",
      "near misses",
      "repairs"
    ],
    "rubric": "Objections answered or explicitly accepted",
    "stop": "Stop unaddressed consequential risk"
  },
  {
    "role": "Implementation Translator",
    "inputs": [
      "accepted design",
      "states",
      "tokens",
      "decisions"
    ],
    "outputs": [
      "engineering contract",
      "mappings",
      "tests",
      "references"
    ],
    "rubric": "Bounded implementation choices",
    "stop": "Stop uncheckable acceptance"
  },
  {
    "role": "Implementation Verifier",
    "inputs": [
      "approved contract",
      "exact candidate"
    ],
    "outputs": [
      "behavior/visual/accessibility/state comparison"
    ],
    "rubric": "Separate source completion, deployment, activation and consumer proof",
    "stop": "Stop candidate mismatch"
  },
  {
    "role": "Measurement Specialist",
    "inputs": [
      "released version",
      "events",
      "baseline",
      "feedback",
      "outcomes"
    ],
    "outputs": [
      "deltas",
      "regressions",
      "ranked opportunities",
      "next cycle"
    ],
    "rubric": "Baseline/window/population/limits",
    "stop": "Stop vanity or unsupported claims"
  }
].map(role => Object.freeze({
  ...role, inputs: Object.freeze(role.inputs), outputs: Object.freeze(role.outputs)
})))

/** A successor describes standard ordering; it never certifies readiness. */
export function nextDesignStage(stage) {
  const index = DESIGN_STAGES.indexOf(stage)
  if (index < 0) throw new Error("unknown design stage")
  return DESIGN_STAGES[index + 1] ?? null
}

/** Start at Intake to omit Grill. A new version requires explicit initialization. */
export function advanceDesignStage(stage, target) {
  const next = nextDesignStage(stage)
  if (next === null || next !== target) throw new Error("invalid design transition")
  return target
}

export function stationForDesignStage(stage) {
  const index = DESIGN_STAGES.indexOf(stage)
  if (index < 0) throw new Error('unknown design stage')
  return stageStations[index]
}

export function stationForDesignGate(gate) {
  const index = DESIGN_GATES.indexOf(gate)
  if (index < 0) throw new Error('unknown design gate')
  return gateStations[index]
}

/** Supplied repository signals only; invalid app.json platforms throw instead of clearing ambiguity. */
export function inspectProjectPlatforms(platforms, { dependencies, paths, appJsonPlatforms, usesSwiftUI }) {
  if (appJsonPlatforms !== undefined && !sharedAnswerValidators.platforms(appJsonPlatforms))
    throw new TypeError('appJsonPlatforms must be a non-empty array of known project platforms')
  const mobileDependency = dependencies.some(name => name === 'react-native' || name === 'expo')
  const appJson = paths.includes('app.json')
  const swift = usesSwiftUI === true || paths.some(path => path.endsWith('.swift'))
  const detected = PROJECT_PLATFORMS.filter(platform =>
    (platform === 'ios' && swift)
    || ((platform === 'ios' || platform === 'android') && (mobileDependency
      || paths.some(path => path === `${platform}/` || path.startsWith(`${platform}/`))
      || (appJson && appJsonPlatforms === undefined)))
    || (appJson && appJsonPlatforms?.includes(platform)))
  const missing = detected.filter(platform => !platforms.includes(platform))
  return { detected, missing, mismatch: missing.length > 0 }
}

/** Schema-valid reported proof eligibility; artifact byte authentication belongs to Prove. */
export function isVerifiedUserPath(evidence, sourceRevision) {
  if (!validateEvidence(evidence) || !evidence.verification) return false
  const proof = evidence.verification
  const persistence = proof.persistence
  return proof.sourceRevision === sourceRevision
    && proof.entryPointStatus === 'exercised' && proof.outcome === 'passed'
    && (persistence === null || persistence.writtenValue.ref !== persistence.independentReadback.ref)
}

export const MOBILE_CAPABILITY_REQUIRED = 'mobile verification capability not installed: add capabilities/mobile-verification (e2e mobile engine / agent-device, stim, argent; see docs/design-manager/parked.md)'

/** Pure Prove precondition; pass never certifies a full design gate or grants authority. */
export function evaluateMobileVerification(project, availableCapabilities, evidence = []) {
  const mobile = project.platforms.filter(platform => platform === 'ios' || platform === 'android')
  if (mobile.length === 0) return { status: 'pass', message: 'mobile verification not required' }
  if (!availableCapabilities.includes('capabilities/mobile-verification'))
    return { status: 'fail', message: MOBILE_CAPABILITY_REQUIRED }
  const missing = mobile.flatMap(platform => ['verify-skill', 'e2e'].filter(method =>
    !evidence.some(item => isVerifiedUserPath(item, project.sourceRevision)
      && item.verification.platform === platform
      && item.verification.method === method)).map(method => `${platform}/${method}`))
  return missing.length
    ? { status: 'pending', message: `mobile evidence required: ${missing.join(', ')}` }
    : { status: 'pass', message: 'reported mobile evidence covers each declared mobile platform' }
}

// Interview snapshots are values for the future factory journal, never a private store.
const entryPlaybooks = {
  'new-product': { inputs: [], artifact: 'product-brief', focus: 'Bound users, jobs, outcomes and the first product version.' },
  feature: { inputs: ['existing-contract'], artifact: 'feature-delta', focus: 'Compare the feature to the existing product contract and protect adjacent workflows.' },
  'workflow-redesign': { inputs: ['current-workflow'], artifact: 'current-proposed-flow', focus: 'Compare current and proposed owners, states, exceptions and failure history.' },
  audit: { inputs: ['built-candidate'], artifact: 'severity-ranked-findings', focus: 'Compare the supplied candidate to explicit criteria; rank findings without authorizing repairs.' },
  'design-system': { inputs: ['current-system'], artifact: 'system-inventory', focus: 'Inventory tokens, components, themes and accessibility across the included workflows.' },
  'platform-derivation': { inputs: ['source-design'], artifact: 'platform-mapping', focus: 'Map source intent to declared target platforms and native behavior.' },
  'concept-evaluation': { inputs: ['candidate-concepts'], artifact: 'concept-comparison', focus: 'Compare supplied concepts against the job, alternatives and declared test questions.' },
  'post-build-refinement': { inputs: ['built-candidate', 'accepted-design', 'operational-baseline'], artifact: 'contract-candidate-comparison', focus: 'Compare the exact candidate with accepted design and observed outcomes; bound a new refinement version.' },
  'automation-interaction': { inputs: ['authority-model'], artifact: 'authority-refusal-recovery-model', focus: 'Make human and automation authority, refusal, recovery and irreversible consequences visible.' }
}
const tierCriteria = {
  lean: [
    ['grill', 'intake', 'Persist one answer before selecting the next question.'],
    ['workflow', 'define', 'Map normal, refusal, recovery, handoff and concurrency paths.'],
    ['concepts', 'explore', 'Compare one or two bounded concepts against the job.'],
    ['owner-testing', 'test', 'Record owner task testing and its limits; simulated critique is not user observation.'],
    ['accessibility', 'test', 'Declare the accessibility target and check critical workflows and states.'],
    ['implementation-criteria', 'build-orchestration', 'Provide checkable implementation acceptance criteria.'],
    ['post-build-review', 'implementation-verification', 'Compare the exact built candidate against the accepted design.']
  ],
  standard: [
    ['domain-research', 'research', 'Record primary sources, patterns, factual gaps and inference.'],
    ['alternatives', 'explore', 'Compare credible alternatives with explicit selection reasons.'],
    ['interactive-prototype', 'prototype', 'Exercise a behaviorally adequate interactive prototype.'],
    ['task-evaluation', 'test', 'Evaluate declared tasks without coaching and record outcomes and limits.'],
    ['failure-states', 'prototype', 'Cover loading, empty, stale, failure, conflict, permission and recovery states.'],
    ['measurable-baseline', 'measure', 'Name the baseline, window, population and limits before measuring deltas.'],
    ['decision-record', 'decide', 'Record the decision, rationale, alternatives and accepted limits.']
  ],
  'high-assurance': [
    ['representative-users', 'test', 'Require representative-user testing; simulated critique cannot substitute.'],
    ['privacy-threat-analysis', 'define', 'Analyze privacy, threats, authority and data-loss risks.'],
    ['formal-accessibility', 'test', 'Require formal accessibility and assistive testing for the declared target.'],
    ['stronger-validation', 'test', 'Validate consequential assumptions with stronger independent evidence.'],
    ['staged-release', 'build-orchestration', 'Specify staged release criteria without granting activation authority.'],
    ['monitoring', 'measure', 'Specify monitored outcomes, thresholds and responses.'],
    ['rollback', 'build-orchestration', 'Specify rollback triggers and recovery verification.'],
    ['independent-assurance', 'implementation-verification', 'Require independent assurance of the exact candidate and its evidence.']
  ]
}
const roleStages = {
  'Design Manager': 'intake', 'Research Specialist': 'research', 'Product/UX Strategist': 'define',
  'Workflow Architect': 'define', 'Information Architect': 'explore', 'Interaction Designer': 'prototype',
  'Prototype Specialist': 'prototype', 'Visual-System Designer': 'explore', 'Accessibility Specialist': 'test',
  'Usability/Evaluation Specialist': 'test', 'Adversarial Reviewer': 'decide',
  'Implementation Translator': 'build-orchestration', 'Implementation Verifier': 'implementation-verification',
  'Measurement Specialist': 'measure'
}
const gateComparisons = {
  problem: ['define', 'Intent against observable problem and outcome.'],
  workflow: ['define', 'Mapped job against owners, states, failures and exceptions.'],
  concept: ['decide', 'Chosen direction against credible alternatives and stated reasons.'],
  interaction: ['test', 'Critical task observations against completion criteria.'],
  system: ['decide', 'Tokens, components and accessibility evidence against the declared system and target.'],
  'build-readiness': ['build-orchestration', 'Design against user/job, critical flow, tested risk assumptions, concept rationale, loading, empty, stale, failure, conflict, permission states, accessibility, checkable acceptance and post-build evaluation.'],
  'implementation-fidelity': ['implementation-verification', 'Exact built candidate against the accepted design contract.'],
  'operational-evidence': ['measure', 'Real task outcomes against the named baseline, window and population.'],
  'version-closure': ['refine', 'Fixed included scope against acceptance, defects, exclusions, limitations, deferred work and the next-version evidence window.']
}
const intakeQuestions = [
  ['platforms', 'Which platforms does this version target?'],
  ['intent', 'What observable outcome should this version achieve?'],
  ['users', 'Who performs the included work?'],
  ['constraints', 'What constraints bound this version?'],
  ['includedWorkflows', 'Which workflows are included in this version?'],
  ['exclusions', 'Which work is explicitly excluded?'],
  ['acceptanceCriteria', 'What observable criteria decide acceptance?'],
  ['evidenceWindow', 'What evidence window informs the next version?'],
  ['version', 'Which bounded version is being initialized?']
]
const tierRank = tier => DESIGN_TIERS.indexOf(tier)
const criteriaFor = tier => DESIGN_TIERS.slice(0, tierRank(tier) + 1)
  .flatMap(key => tierCriteria[key])
function tierChoices() {
  return DESIGN_TIERS.map((value, index) => ({ value,
    included: criteriaFor(value).map(([, , criterion]) => criterion),
    omitted: DESIGN_TIERS.slice(index + 1).flatMap(key => tierCriteria[key].map(([, , criterion]) => criterion)),
    effort: ['Concise owner-led design and review', 'Research, prototype and measured task evaluation',
      'Representative participants, formal checks and independent release assurance'][index],
    protectedRisks: ['Core workflow and accessibility', 'Core workflow, failure states and unsupported decisions',
      'Privacy, threats, accessibility, data loss and consequential release risks'][index].split(', ')
  }))
}
const text = value => typeof value === 'string' && value.trim().length > 0
function exactKeys(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => [...required, ...optional].includes(key))
}

export const DESIGN_LAYERS = Object.freeze(['evidence', 'domain', 'need', 'strategy', 'model', 'flow', 'surface'])
const layerSupports = ['strong', 'partial', 'assumed', 'weak', 'not-started', 'N/A']
const positiveRevision = value => Number.isSafeInteger(value) && value > 0
function checkLayer(assessment) {
  if (!exactKeys(assessment, ['layer', 'revision', 'decision', 'evidenceCriterion', 'criterionMet',
    'artifacts', 'uncertainty', 'dependencies', 'support', 'notApplicableReason', 'question'])
    || !DESIGN_LAYERS.includes(assessment.layer) || !positiveRevision(assessment.revision)
    || !layerSupports.includes(assessment.support)
    || ![assessment.decision, assessment.evidenceCriterion, assessment.uncertainty].every(text)
    || typeof assessment.criterionMet !== 'boolean'
    || !Array.isArray(assessment.artifacts) || !Array.from(assessment.artifacts).every(a => validateArtifact(a))
    || !Array.isArray(assessment.dependencies) || !Array.from(assessment.dependencies).every(d =>
      exactKeys(d, ['layer', 'revision']) && positiveRevision(d.revision)
      && DESIGN_LAYERS.indexOf(d.layer) >= 0
      && DESIGN_LAYERS.indexOf(d.layer) < DESIGN_LAYERS.indexOf(assessment.layer))
    || new Set(assessment.dependencies.map(d => d.layer)).size !== assessment.dependencies.length)
    throw new TypeError('invalid layer assessment or dependency')
  if (assessment.support === 'N/A') {
    if (!text(assessment.notApplicableReason) || assessment.dependencies.length
      || assessment.criterionMet || assessment.question !== null)
      throw new TypeError('N/A requires an explicit no-dependent applicability reason')
  } else {
    if (assessment.notApplicableReason !== null) throw new TypeError('applicable layer cannot claim an N/A reason')
    if (assessment.support === 'strong') {
      if (!assessment.criterionMet || !assessment.artifacts.length || assessment.question !== null)
        throw new TypeError('strong layer requires artifacts and a met evidence criterion')
    } else if (!exactKeys(assessment.question, ['id', 'prompt']) || !text(assessment.question.id)
      || !text(assessment.question.prompt) || assessment.question.prompt.split('?').length !== 2)
      throw new TypeError('unsupported layer requires exactly one unresolved question')
  }
}

function checkLayerSet(assessments) {
  if (!Array.isArray(assessments) || assessments.length !== DESIGN_LAYERS.length)
    throw new TypeError('assess every design layer in dependency order')
  for (const [index, layer] of DESIGN_LAYERS.entries()) {
    const assessment = assessments[index]
    checkLayer(assessment)
    if (assessment.layer !== layer) throw new TypeError('assess every design layer in dependency order')
    if (assessment.support === 'N/A') continue
    for (const dependency of assessment.dependencies) {
      const target = assessments.find(a => a.layer === dependency.layer)
      if (target.support === 'N/A') throw new TypeError('N/A cannot have an in-scope dependent decision')
    }
  }
}

function checkDependencyRevisions(assessment, assessments) {
  for (const dependency of assessment.dependencies) {
    if (dependency.revision !== assessments.find(a => a.layer === dependency.layer).revision)
      throw new TypeError('stale dependency assessment: reread the current layer revision')
  }
}

// Preserve supplied assessments; derive invalidation from revisions and transitive support.
function layerDiagnosis(assessments) {
  if (!assessments) return null
  const invalidatedLayers = []
  for (const assessment of assessments) {
    if (assessment.support === 'N/A') continue
    if (assessment.dependencies.some(d => {
      const target = assessments.find(a => a.layer === d.layer)
      return target.revision !== d.revision || target.support !== 'strong' || invalidatedLayers.includes(d.layer)
    })) invalidatedLayers.push(assessment.layer)
  }
  return { assessments, invalidatedLayers,
    pendingLayer: assessments.find(a => a.support !== 'N/A'
      && (a.support !== 'strong' || invalidatedLayers.includes(a.layer)))?.layer ?? null }
}

function reviseLayer(assessments, assessment) {
  if (!assessments) throw new TypeError('assess all layers before reassessment')
  checkLayer(assessment)
  const current = assessments.find(a => a.layer === assessment.layer)
  if (assessment.revision !== current.revision + 1) throw new TypeError('reassessment requires the next layer revision')
  const revised = assessments.map(a => a.layer === assessment.layer ? assessment : a)
  checkLayerSet(revised)
  checkDependencyRevisions(assessment, revised)
  if (assessment.support === 'strong' && layerDiagnosis(revised).invalidatedLayers.includes(assessment.layer))
    throw new TypeError('strong assessment cannot depend on unsupported decisions')
  return revised
}

function questionFor(interview, answers, proposal = null, assessments = null) {
  const make = (id, prompt, choices) => ({ id,
    prompt: `${interview.projectId}: ${prompt}`, ...(choices ? { choices } : {}) })
  if (!answers.entry) return make('entry', 'Which design entry path applies?', DESIGN_ENTRIES)
  if (!answers.risk) return make('risk', 'What is the consequential risk level?', ['bounded', 'consequential', 'unknown'])
  if (!answers.tier) return { ...make('tier', 'Which assurance tier do you select?', tierChoices()),
    recommendation: answers.risk === 'bounded' ? 'standard' : 'high-assurance' }
  for (const [id, prompt] of intakeQuestions) {
    if (answers[id] === undefined) {
      const question = make(id, prompt)
      if (id === 'platforms' && interview.signals) question.requiredPlatforms =
        inspectProjectPlatforms([], interview.signals).detected
      return question
    }
  }
  if (proposal) return { ...make('scope-expansion', 'Do you accept this scope expansion?', ['accept', 'decline']),
    expansion: { ...proposal, before: answers.includedWorkflows,
      after: [...answers.includedWorkflows, proposal.workflow] } }
  const workflowQuestion = (index, workflow) => {
    if (answers[`scope-added:${index}`] && !answers[`scope-criteria:${index}`])
      return make(`scope-criteria:${index}`, `What observable criterion decides acceptance of workflow “${workflow}”?`)
    if (!answers[`assurance:${index}`]) return { ...make(`assurance:${index}`,
      `Which assurance tier does workflow “${workflow}” require?`, tierChoices().map(choice => ({
        ...choice, scopeImpact: choice.included.filter(criterion => !criteriaFor(answers.tier).some(([, , text]) => text === criterion))
      }))),
    recommendation: answers.risk === 'bounded' ? answers.tier : 'high-assurance' }
    return null
  }
  // Scope authorization stays separate; assess the newly bounded work afterward.
  for (const [index, workflow] of answers.includedWorkflows.entries()) {
    const question = answers[`scope-added:${index}`] && workflowQuestion(index, workflow)
    if (question) return question
  }
  if (!assessments) return make('layer-assessments', 'Which supplied assessments cover all seven design layers?')
  const diagnosis = layerDiagnosis(assessments)
  if (diagnosis.pendingLayer) {
    const assessment = assessments.find(a => a.layer === diagnosis.pendingLayer)
    const invalidated = diagnosis.invalidatedLayers.includes(assessment.layer)
    const uncertainty = invalidated ? `Dependency evidence changed or remains unsupported for ${assessment.layer}: ${assessment.evidenceCriterion}`
      : assessment.uncertainty
    const pending = invalidated ? { id: 'reassess', prompt: `Which evidence reassesses the ${assessment.layer} decision against its current dependencies?` }
      : assessment.question
    return { ...make(`layer:${assessment.layer}:${assessment.revision}:${pending.id}`, pending.prompt),
      layer: assessment.layer, uncertainty }
  }
  for (const id of entryPlaybooks[answers.entry].inputs) {
    if (!answers[`input:${id}`]) return make(`input:${id}`, `Which supplied artifact contains the ${id.replaceAll('-', ' ')}?`)
  }
  for (const [index, workflow] of answers.includedWorkflows.entries()) {
    const question = workflowQuestion(index, workflow)
    if (question) return question
  }
  return null
}

function checkAnswer(question, answer) {
  if (!exactKeys(answer, ['status'], ['value'])
    || !['answered', 'unknown', 'declined'].includes(answer.status)
    || (answer.status !== 'answered' && Object.hasOwn(answer, 'value')))
    throw new TypeError('invalid interview answer')
  if (answer.status !== 'answered') return
  if (question.choices && !question.choices.some(choice => (choice.value ?? choice) === answer.value))
    throw new TypeError(`invalid answer for ${question.id}`)
  if (['intent', 'users', 'constraints'].includes(question.id) && !text(answer.value))
    throw new TypeError(`nonblank answer required for ${question.id}`)
  const validateShared = sharedAnswerValidators[question.id]
  if (validateShared && !validateShared(answer.value))
    throw new TypeError(`${['platforms', 'includedWorkflows', 'exclusions', 'acceptanceCriteria'].includes(question.id)
      ? 'invalid list' : 'invalid answer'} for ${question.id}`)
  if (['platforms', 'includedWorkflows', 'exclusions', 'acceptanceCriteria'].includes(question.id)) {
    const values = answer.value
    if (new Set(values).size !== values.length)
      throw new TypeError(`invalid list for ${question.id}`)
    if (question.requiredPlatforms?.some(platform => !values.includes(platform)))
      throw new TypeError('platform mismatch: reconcile supplied mobile signals explicitly')
  }
  if (question.id.startsWith('scope-criteria:') && !validateScopeCriterion(answer.value))
    throw new TypeError('new workflow requires an observable acceptance criterion')
  if (question.id.startsWith('input:') && !validateArtifact(answer.value))
    throw new TypeError('supplied input must be an ArtifactRef')
  if (question.id === 'layer-assessments') {
    checkLayerSet(answer.value)
    for (const assessment of answer.value) checkDependencyRevisions(assessment, answer.value)
  }
  if (question.layer && (!exactKeys(answer.value, ['response', 'assessment']) || !text(answer.value.response)
    || answer.value.assessment?.layer !== question.layer))
    throw new TypeError('one response and reassessment of the pending layer required')
}

function replayInterview(interview) {
  if (!exactKeys(interview, ['schema', 'projectId', 'sourceRevision', 'trace'], ['signals'])
    || interview.schema !== 'design-interview.v1' || !validateProjectId(interview.projectId)
    || !validateSourceRevision(interview.sourceRevision) || !Array.isArray(interview.trace))
    throw new TypeError('invalid design interview')
  if (Object.hasOwn(interview, 'signals')) {
    const signals = interview.signals
    if (!exactKeys(signals, ['dependencies', 'paths'], ['appJsonPlatforms', 'usesSwiftUI'])
      || !validateSignalStrings(signals.dependencies) || !validateSignalStrings(signals.paths)
      || (signals.usesSwiftUI !== undefined && typeof signals.usesSwiftUI !== 'boolean'))
      throw new TypeError('invalid supplied platform signals')
    inspectProjectPlatforms([], signals)
  }
  const answers = {}
  let proposal = null
  let assessments = null
  let priorAssessments = null
  const deferred = new Set()
  for (const event of interview.trace) {
    const question = questionFor(interview, answers, proposal, assessments)
    if (exactKeys(event, ['assessment'])) {
      if (question?.layer === event.assessment?.layer && ['strong', 'N/A'].includes(event.assessment?.support))
        throw new TypeError('record one answer before resolving the pending layer')
      assessments = reviseLayer(assessments, event.assessment)
      continue
    }
    if (exactKeys(event, ['proposal'])) {
      if (question || !exactKeys(event.proposal, ['workflow', 'reason'])
        || !text(event.proposal.workflow) || !text(event.proposal.reason)
        || answers.includedWorkflows.includes(event.proposal.workflow)
        || answers.exclusions.includes(event.proposal.workflow))
        throw new TypeError('scope proposal requires completed intake and new non-excluded work')
      proposal = event.proposal
      continue
    }
    if (!question || !exactKeys(event, ['question', 'answer']) || !isDeepStrictEqual(event.question, question))
      throw new TypeError('trace must contain exactly one expected question per answer')
    checkAnswer(question, event.answer)
    if (event.answer.status === 'answered') {
      if (question.id === 'layer-assessments') {
        if (priorAssessments && event.answer.value.some((a, index) => a.revision !== priorAssessments[index].revision + 1))
          throw new TypeError('expanded scope requires the next revision of every layer')
        assessments = event.answer.value
      }
      else if (question.layer) assessments = reviseLayer(assessments, event.answer.value.assessment)
      else if (question.id === 'scope-expansion') {
        if (event.answer.value === 'accept') {
          priorAssessments = assessments
          assessments = null
          answers[`scope-added:${answers.includedWorkflows.length}`] = true
          answers.includedWorkflows = [...answers.includedWorkflows, proposal.workflow]
          deferred.delete(proposal.workflow)
        }
        else deferred.add(proposal.workflow)
        proposal = null
      } else {
        if (question.id === 'exclusions' && event.answer.value.some(value => answers.includedWorkflows.includes(value)))
          throw new TypeError('a workflow cannot be both included and excluded')
        answers[question.id] = event.answer.value
        if (question.id.startsWith('scope-criteria:'))
          answers.acceptanceCriteria = [...answers.acceptanceCriteria, event.answer.value]
      }
    }
  }
  return { answers, proposal, assessments, deferred: [...deferred] }
}

function initializedState(interview, answers, deferred) {
  const project = { schema: 'design-project.v1', projectId: interview.projectId,
    sourceRevision: interview.sourceRevision, platforms: answers.platforms,
    entry: answers.entry, tier: answers.tier, stage: 'intake', status: 'active',
    versionContract: { version: answers.version, includedWorkflows: answers.includedWorkflows,
      exclusions: answers.exclusions, acceptanceCriteria: answers.acceptanceCriteria,
      evidenceWindow: answers.evidenceWindow, knownLimitations: [], blockingDefects: [],
      deferredRefinements: deferred }, handoffs: [], gates: [] }
  if (!validateProject(project)) throw new TypeError('initialized project violates slice 1 contract')
  const workflows = project.versionContract.includedWorkflows
  const requirements = DESIGN_ROLES.map(contract => ({
    id: `checklist:${contract.role}`, stage: roleStages[contract.role], role: contract.role,
    artifacts: [...contract.outputs], criterion: contract.rubric, stop: contract.stop,
    workflows: [...workflows], status: 'pending' }))
  for (const gate of DESIGN_GATES) {
    const [stage, criterion] = gateComparisons[gate]
    requirements.push({ id: `gate:${gate}`, stage, role: 'Design Manager',
      artifacts: [`${gate} comparison`], criterion,
      stop: 'Stop missing comparison evidence; initialization never passes a gate',
      workflows: [...workflows], status: 'pending' })
  }
  const playbook = entryPlaybooks[answers.entry]
  requirements.push({ id: `entry:${playbook.artifact}`, stage: 'define', role: 'Design Manager',
    artifacts: [playbook.artifact], criterion: playbook.focus, stop: 'Stop omitted critical entry work',
    workflows: [...workflows], status: 'pending' })
  requirements.push({ id: 'proof:criterion-e2e', stage: 'implementation-verification', role: 'Implementation Verifier',
    artifacts: ['criterion-to-entry-point map', 'exact-revision e2e action/assertion/result', 'independent stored-value readback'],
    criterion: 'Every user-facing acceptance criterion requires exact-revision e2e behavioral evidence; unit/component or direct-driver-only receipts fail. Stored writes require independent readback; skipped paths never verify.',
    stop: 'Stop missing criterion-bound e2e, stale revisions, skipped paths or missing stored-value readback',
    workflows: [...workflows], status: 'pending' })
  if (project.platforms.some(p => p === 'ios' || p === 'android')) requirements.push({
    id: 'proof:mobile', stage: 'implementation-verification', role: 'Implementation Verifier',
    artifacts: ['simulator/emulator VERIFY skill receipt', 'e2e mobile-engine receipt'],
    criterion: 'Require simulator/emulator VERIFY skill and e2e mobile-engine user-path proofs on each declared mobile platform and exact revision. Qualification remains pending.',
    stop: MOBILE_CAPABILITY_REQUIRED, workflows: [...workflows], status: 'pending' })
  for (const tier of DESIGN_TIERS) {
    const applicable = workflows.filter((_, index) => Math.max(tierRank(answers.tier),
      tierRank(answers[`assurance:${index}`])) >= tierRank(tier))
    if (!applicable.length) continue
    for (const [id, stage, criterion] of tierCriteria[tier]) requirements.push({
      id: `tier:${id}`, stage, role: 'Design Manager', artifacts: [id], criterion,
      stop: 'Stop missing tier evidence or unsupported evidence claims', workflows: applicable, status: 'pending' })
  }
  return { project, requirements, inputs: Object.fromEntries(Object.entries(answers)
    .filter(([id]) => ['intent', 'users', 'constraints'].includes(id) || id.startsWith('input:'))) }
}

export function startDesignInterview({ projectId, sourceRevision, signals }) {
  return resumeDesignInterview({ schema: 'design-interview.v1', projectId, sourceRevision, trace: [],
    ...(signals === undefined ? {} : { signals }) })
}

export function resumeDesignInterview(interview) {
  const snapshot = structuredClone(interview)
  const { answers, proposal, assessments, deferred } = replayInterview(snapshot)
  const question = questionFor(snapshot, answers, proposal, assessments)
  return { interview: snapshot, question: structuredClone(question),
    diagnosis: structuredClone(layerDiagnosis(assessments)),
    ...(question ? { project: null, requirements: [], inputs: {} }
      : structuredClone(initializedState(snapshot, answers, deferred))) }
}

export function answerDesignInterview(interview, response) {
  if (!exactKeys(response, ['questionId', 'answer'])) throw new TypeError('submit one answer at a time')
  const view = resumeDesignInterview(interview)
  if (!view.question || response.questionId !== view.question.id) throw new TypeError('answer the pending question')
  checkAnswer(view.question, response.answer)
  view.interview.trace.push({ question: view.question, answer: structuredClone(response.answer) })
  return resumeDesignInterview(view.interview)
}

/** Supplied new evidence revises one layer and invalidates dependent decisions. */
export function reassessDesignLayer(interview, assessment) {
  const view = resumeDesignInterview(interview)
  view.interview.trace.push({ assessment: structuredClone(assessment) })
  return resumeDesignInterview(view.interview)
}

/** Proposals never modify scope until their single pending question is answered. */
export function proposeDesignScope(interview, proposal) {
  const view = resumeDesignInterview(interview)
  if (view.question) throw new TypeError('finish the pending interview before proposing scope')
  view.interview.trace.push({ proposal: structuredClone(proposal) })
  return resumeDesignInterview(view.interview)
}

/** Compares reported initialization with its replay; this is not design acceptance. */
export function inspectDesignInitialization(value) {
  try {
    const expected = resumeDesignInterview(value?.interview)
    if (!expected.project) return { status: 'fail', errors: ['interview is incomplete; answer the pending question'] }
    if (!isDeepStrictEqual(value, expected)) return { status: 'fail',
      errors: ['initialization differs from the interview: restore required work, explicit tier and approved scope'] }
    return { status: 'pass', errors: [] }
  } catch (error) {
    return { status: 'fail', errors: [error.message] }
  }
}
