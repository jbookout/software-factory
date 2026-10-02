// Pure development-time contracts. No dispatch, persistence or acceptance authority.
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
