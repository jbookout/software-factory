// Pure development-time contracts. No dispatch, persistence or acceptance authority.
import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'

const projectSchema = JSON.parse(readFileSync(new URL('../schemas/design-project.schema.json', import.meta.url)))
const validateEvidence = new Ajv2020({ strict: true }).addSchema(projectSchema)
  .compile({ $ref: `${projectSchema.$id}#/$defs/evidence` })

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
export function inspectProjectPlatforms(platforms, { dependencies, paths, appJsonPlatforms }) {
  if (appJsonPlatforms !== undefined && (!Array.isArray(appJsonPlatforms)
    || appJsonPlatforms.length === 0
    || !appJsonPlatforms.every(platform => PROJECT_PLATFORMS.includes(platform))))
    throw new TypeError('appJsonPlatforms must be a non-empty array of known project platforms')
  const mobileDependency = dependencies.some(name => name === 'react-native' || name === 'expo')
  const native = platform => paths.some(path => path === `${platform}/` || path.startsWith(`${platform}/`))
  const appJson = paths.includes('app.json')
  const detected = PROJECT_PLATFORMS.filter(platform =>
    ((platform === 'ios' || platform === 'android') && (mobileDependency || native(platform)
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
