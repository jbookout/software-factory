import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { DESIGN_STAGES, DESIGN_TIERS, DESIGN_ROLES, DESIGN_GATES, EVIDENCE_STRENGTHS,
  nextDesignStage, advanceDesignStage } from 'software-factory/design-manager'

const schema = JSON.parse(readFileSync(new URL('../schemas/design-project.schema.json', import.meta.url)))
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema)
const artifact = () => ({ ref: 'fixture:prototype', digest: `sha256:${'a'.repeat(64)}` })
const project = (projectId = 'unrelated-sample') => ({
  schema: 'design-project.v1', projectId, sourceRevision: 'b'.repeat(40),
  entry: 'post-build-refinement', tier: 'standard', stage: 'intake', status: 'active',
  versionContract: { version: 1, includedWorkflows: ['retrieve a fact'], exclusions: [],
    knownLimitations: [], blockingDefects: [], acceptanceCriteria: ['correct fact retrieved'],
    deferredRefinements: [], evidenceWindow: 'two weeks of real use' },
  handoffs: [{ role: 'Research Specialist', makerId: 'maker', artifact: artifact(),
    evidence: [{ ...artifact(), strength: 'simulated-critique' }],
    unresolvedQuestions: [], confidence: 0.5, limits: ['not user research'] }],
  gates: [{ gate: 'problem', status: 'pending', artifact: artifact(),
    reviewerId: 'independent-reviewer', evidence: [] }]
})

test('standard lifecycle matches blueprint and forbids every non-adjacent transition', () => {
  assert.deepEqual(DESIGN_STAGES, ['grill', 'intake', 'research', 'define', 'explore',
    'prototype', 'test', 'decide', 'build-orchestration', 'implementation-verification', 'measure', 'refine'])
  for (const [index, stage] of DESIGN_STAGES.entries()) {
    assert.equal(nextDesignStage(stage), DESIGN_STAGES[index + 1] ?? null)
    for (const target of DESIGN_STAGES) {
      if (target === DESIGN_STAGES[index + 1]) assert.equal(advanceDesignStage(stage, target), target)
      else assert.throws(() => advanceDesignStage(stage, target), /invalid design transition/)
    }
  }
  for (const invalid of [null, 0, {}, 'deploy', 'constructor', '__proto__'])
    assert.throws(() => nextDesignStage(invalid), /unknown design stage/)
})

test('catalogs encode blueprint tiers, roles, gates and ranked evidence without model bindings', () => {
  assert.deepEqual(DESIGN_TIERS, ['lean', 'standard', 'high-assurance'])
  assert.deepEqual(DESIGN_GATES, ['problem', 'workflow', 'concept', 'interaction', 'system',
    'build-readiness', 'implementation-fidelity', 'operational-evidence', 'version-closure'])
  assert.deepEqual(DESIGN_ROLES.map(x => x.role), ['Design Manager', 'Research Specialist',
    'Product/UX Strategist', 'Workflow Architect', 'Information Architect', 'Interaction Designer',
    'Prototype Specialist', 'Visual-System Designer', 'Accessibility Specialist',
    'Usability/Evaluation Specialist', 'Adversarial Reviewer', 'Implementation Translator',
    'Implementation Verifier', 'Measurement Specialist'])
  assert.deepEqual(EVIDENCE_STRENGTHS, ['target-user-observation', 'representative-user-testing',
    'domain-expert-feedback', 'owner-task-testing', 'heuristic-accessibility',
    'competitor-pattern-research', 'simulated-critique'])
  for (const role of DESIGN_ROLES) {
    assert.ok(role.inputs.length && role.outputs.length && role.rubric && role.stop)
    assert.equal('model' in role, false)
    assert.ok(Object.isFrozen(role) && Object.isFrozen(role.inputs) && Object.isFrozen(role.outputs))
  }
  assert.deepEqual(schema.$defs.role.enum, DESIGN_ROLES.map(x => x.role))
  assert.deepEqual(schema.properties.stage.enum, DESIGN_STAGES)
  assert.deepEqual(schema.properties.tier.enum, DESIGN_TIERS)
  assert.deepEqual(schema.$defs.gate.properties.gate.enum, DESIGN_GATES)
  assert.deepEqual(schema.$defs.evidence.properties.strength.enum, EVIDENCE_STRENGTHS)
  assert.throws(() => DESIGN_STAGES.push('deploy'), TypeError)
})

test('strict schema accepts DoctorCRE and unrelated project records, including optional Grill', () => {
  for (const id of ['DoctorCRE', 'unrelated-sample']) {
    for (const stage of DESIGN_STAGES) {
      const value = project(id)
      value.stage = stage
      assert.equal(validate(value), true, JSON.stringify(validate.errors))
    }
  }
})

test('schema rejects missing contracts, extra authority fields and malformed handoffs/evidence', () => {
  const cases = [
    x => { delete x.versionContract },
    x => { x.tier = 'unknown' },
    x => { x.stage = 'deployed' },
    x => { x.deploy = true },
    x => { x.sourceRevision = 'main' },
    x => { x.versionContract.version = 0 },
    x => { x.versionContract.includedWorkflows = [] },
    x => { x.versionContract.acceptanceCriteria = [] },
    x => { x.versionContract.evidenceWindow = ' ' },
    x => { x.handoffs[0].confidence = 1.1 },
    x => { x.handoffs[0].role = 'Claude' },
    x => { delete x.handoffs[0].limits },
    x => { x.handoffs[0].artifact.digest = 'unverified' },
    x => { x.handoffs[0].evidence[0].strength = 'user-research' },
    x => { x.handoffs[0].evidence[0].apiKey = 'forbidden-field' },
    x => { x.gates[0].gate = 'release' },
    x => { x.gates[0].status = 'accepted' },
    x => { x.gates[0].reviewerId = '' }
  ]
  for (const mutate of cases) {
    const value = project()
    mutate(value)
    assert.equal(validate(value), false, `accepted invalid case: ${mutate}`)
    assert.ok(validate.errors.some(x => x.instancePath !== undefined))
  }
})

test('declaration unions and required fields match the serialized schema contract', async () => {
  const { parse } = await import('@typescript-eslint/parser')
  const source = readFileSync(new URL('../src/design-manager.d.mts', import.meta.url), 'utf8')
  const ast = parse(source, { sourceType: 'module', ecmaVersion: 'latest' })
  const declarations = new Map(ast.body.map(x => [x.declaration.id?.name, x.declaration]))
  const enums = {
    DesignStage: schema.properties.stage.enum, DesignTier: schema.properties.tier.enum,
    DesignEntry: schema.properties.entry.enum, WorkStatus: schema.properties.status.enum,
    DesignRole: schema.$defs.role.enum, DesignGate: schema.$defs.gate.properties.gate.enum,
    GateStatus: schema.$defs.gate.properties.status.enum,
    EvidenceStrength: schema.$defs.evidence.properties.strength.enum,
    ModelMode: ['fast', 'thorough', 'specialist', 'best-available', 'efficient-eco']
  }
  for (const [name, values] of Object.entries(enums)) {
    const annotation = declarations.get(name).typeAnnotation
    assert.deepEqual(annotation.types.map(x => x.literal.value), values, name)
  }
  for (const [name, contract] of Object.entries({ DesignProject: schema,
    ArtifactRef: schema.$defs.artifact, HandoffManifest: schema.$defs.handoff,
    GateRecord: schema.$defs.gate, VersionContract: schema.$defs.versionContract })) {
    const members = declarations.get(name).body.body
    assert.deepEqual(members.map(x => x.key.name).sort(), [...contract.required].sort(), name)
    assert.ok(members.every(x => !x.optional), `${name} has optional required fields`)
  }
  assert.equal(declarations.get('EvidenceRef').extends[0].expression.name, 'ArtifactRef')
})
