import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { DESIGN_STAGES, DESIGN_TIERS, DESIGN_ROLES, DESIGN_GATES, EVIDENCE_STRENGTHS,
  nextDesignStage, advanceDesignStage, DESIGN_STATIONS, PROJECT_PLATFORMS,
  stationForDesignStage, stationForDesignGate, inspectProjectPlatforms,
  isVerifiedUserPath, evaluateMobileVerification, MOBILE_CAPABILITY_REQUIRED } from 'software-factory/design-manager'

const schema = JSON.parse(readFileSync(new URL('../schemas/design-project.schema.json', import.meta.url)))
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema)
const validateEvidence = new Ajv2020({ strict: true }).addSchema(schema)
  .compile({ $ref: `${schema.$id}#/$defs/evidence` })
const artifact = () => ({ ref: 'fixture:prototype', digest: `sha256:${'a'.repeat(64)}` })
const project = (projectId = 'unrelated-sample') => ({
  schema: 'design-project.v1', projectId, sourceRevision: 'b'.repeat(40),
  platforms: ['web'], entry: 'post-build-refinement', tier: 'standard', stage: 'intake', status: 'active',
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
    DesignStation: DESIGN_STATIONS, ProjectPlatform: PROJECT_PLATFORMS,
    EvaluationOutcome: schema.$defs.verificationProof.properties.outcome.enum,
    EntryPointStatus: schema.$defs.verificationProof.properties.entryPointStatus.enum,
    VerificationMethod: schema.$defs.verificationProof.properties.method.enum,
    ModelMode: ['fast', 'thorough', 'specialist', 'best-available', 'efficient-eco']
  }
  for (const [name, values] of Object.entries(enums)) {
    const annotation = declarations.get(name).typeAnnotation
    assert.deepEqual(annotation.types.map(x => x.literal.value), values, name)
  }
  for (const [name, contract] of Object.entries({ DesignProject: schema,
    VerificationProof: schema.$defs.verificationProof, PersistenceProof: schema.$defs.persistenceProof,
    ArtifactRef: schema.$defs.artifact, HandoffManifest: schema.$defs.handoff,
    GateRecord: schema.$defs.gate, VersionContract: schema.$defs.versionContract })) {
    const members = declarations.get(name).body.body
    assert.deepEqual(members.map(x => x.key.name).sort(), [...contract.required].sort(), name)
    assert.ok(members.every(x => !x.optional), `${name} has optional required fields`)
  }
  assert.equal(declarations.get('EvidenceRef').extends[0].expression.name, 'ArtifactRef')
})

const proof = (platform = 'web', method = 'verify-skill') => ({
  ...artifact(), strength: method === 'e2e' ? 'simulated-critique' : 'owner-task-testing',
  verification: { sourceRevision: 'b'.repeat(40), platform, method,
    entryPoint: '/notes/new', entryPointStatus: 'exercised', outcome: 'passed',
    actionAndResult: artifact(), persistence: { writtenValue: artifact(),
      independentReadback: { ...artifact(), ref: 'fixture:database-readback' },
      readbackMethod: 'read-only storage query after the user saves' } }
})

test('stations own every existing stage and gate without changing the stage path', () => {
  assert.deepEqual(DESIGN_STATIONS, ['research', 'define', 'design', 'prove', 'ship'])
  assert.deepEqual(DESIGN_STAGES.map(stationForDesignStage), [
    'define', 'define', 'research', 'define', 'design', 'design', 'prove', 'design',
    'ship', 'prove', 'prove', 'define'])
  assert.deepEqual(DESIGN_GATES.map(stationForDesignGate), [
    'define', 'define', 'design', 'prove', 'design', 'ship', 'prove', 'prove', 'ship'])
  for (const input of ['constructor', '__proto__', 'release', null]) {
    assert.throws(() => stationForDesignStage(input), /unknown design stage/)
    assert.throws(() => stationForDesignGate(input), /unknown design gate/)
  }
})

test('platform intake is explicit and repository mobile signals flag mismatches', () => {
  assert.deepEqual(PROJECT_PLATFORMS, ['web', 'ios', 'android', 'desktop'])
  assert.deepEqual(inspectProjectPlatforms(['web'], { dependencies: [], paths: [] }),
    { detected: [], missing: [], mismatch: false })
  for (const dependencies of [['react-native'], ['expo']]) {
    assert.deepEqual(inspectProjectPlatforms(['web'], { dependencies, paths: [] }),
      { detected: ['ios', 'android'], missing: ['ios', 'android'], mismatch: true })
  }
  assert.deepEqual(inspectProjectPlatforms(['ios'], { dependencies: [], paths: ['ios/App.swift'] }),
    { detected: ['ios'], missing: [], mismatch: false })
  assert.deepEqual(inspectProjectPlatforms(['web'], { dependencies: [], paths: ['android/app/build.gradle'] }).missing, ['android'])
  assert.equal(inspectProjectPlatforms(['web'], { dependencies: [], paths: ['app.json'] }).mismatch, true)
  assert.equal(inspectProjectPlatforms(['web'], { dependencies: [], paths: ['app.json'], appJsonPlatforms: ['web'] }).mismatch, false)
  for (const platforms of [undefined, [], ['watch'], ['ios', 'ios']]) {
    const value = project(); value.platforms = platforms
    assert.equal(validate(value), false)
  }
})

test('verification proof requires exercised user path, fresh revision and independent persistence readback', () => {
  const value = project(); value.handoffs[0].evidence = [proof()]
  assert.equal(validate(value), true, JSON.stringify(validate.errors))
  assert.equal(isVerifiedUserPath(proof(), value.sourceRevision), true)
  const withoutPersistence = proof(); withoutPersistence.verification.persistence = null
  assert.equal(isVerifiedUserPath(withoutPersistence, value.sourceRevision), true)
  for (const mutate of [
    x => { x.verification.entryPointStatus = 'skipped' },
    x => { x.verification.entryPointStatus = 'blocked' },
    x => { x.verification.outcome = 'failed' },
    x => { x.verification.outcome = 'blocked' },
    x => { x.verification.sourceRevision = 'c'.repeat(40) },
    x => { delete x.verification.persistence.writtenValue.digest },
    x => { delete x.verification.persistence.independentReadback },
    x => { x.verification.persistence.independentReadback = x.verification.persistence.writtenValue }
  ]) {
    const evidence = proof(); mutate(evidence)
    assert.equal(isVerifiedUserPath(evidence, value.sourceRevision), false)
  }
  assert.equal(isVerifiedUserPath({ ...artifact(), strength: 'simulated-critique' }, value.sourceRevision), false)
  for (const mutate of [
    x => { x.verification.entryPointStatus = 'verified' },
    x => { x.verification.outcome = 'pending' },
    x => { delete x.verification.actionAndResult },
    x => { x.verification.extra = true },
    x => { x.verification.persistence.independentReadback.digest = 'wrong' }
  ]) {
    const evidence = proof(); mutate(evidence); value.handoffs[0].evidence = [evidence]
    assert.equal(validate(value), false)
  }
  value.handoffs[0].evidence = [proof()]; value.gates[0].status = 'blocked'
  assert.equal(validate(value), true)
})

test('ios without mobile capability fails Prove with the exact remediation', () => {
  const value = project(); value.platforms = ['ios']
  const message = 'mobile verification capability not installed: add capabilities/mobile-verification (e2e mobile engine / agent-device, stim, argent; see docs/design-manager/parked.md)'
  assert.equal(MOBILE_CAPABILITY_REQUIRED, message)
  assert.deepEqual(evaluateMobileVerification(value, []), { status: 'fail', message })
  for (const platforms of [['android'], ['web', 'ios']]) {
    value.platforms = platforms
    assert.deepEqual(evaluateMobileVerification(value, []), { status: 'fail', message })
  }
  value.platforms = ['web', 'desktop']
  assert.equal(evaluateMobileVerification(value, []).status, 'pass')
})

test('reported mobile coverage requires verify skill and e2e on each exact platform/revision', () => {
  const value = project(); value.platforms = ['ios', 'android']
  const available = ['capabilities/mobile-verification']
  assert.equal(evaluateMobileVerification(value, available).status, 'pending')
  const evidence = ['ios', 'android'].flatMap(p => [proof(p), proof(p, 'e2e')])
  assert.equal(evaluateMobileVerification(value, available, evidence).status, 'pass')
  evidence[3].verification.entryPointStatus = 'skipped'
  assert.equal(evaluateMobileVerification(value, available, evidence).status, 'pending')
  evidence[3] = proof('android', 'e2e'); evidence[3].verification.sourceRevision = 'c'.repeat(40)
  assert.equal(evaluateMobileVerification(value, available, evidence).status, 'pending')
})

test('malformed receipts fail the shared schema, direct eligibility and mobile coverage', async t => {
  const mutations = {
    'missing evidence ref': x => { delete x.ref },
    'missing evidence digest': x => { delete x.digest },
    'missing evidence strength': x => { delete x.strength },
    'blank evidence ref': x => { x.ref = ' ' },
    'invalid evidence digest': x => { x.digest = 'garbage' },
    'unknown evidence strength': x => { x.strength = 'real' },
    'extra evidence field': x => { x.extra = true },
    'missing platform': x => { delete x.verification.platform },
    'unknown platform': x => { x.verification.platform = 'watch' },
    'missing method': x => { delete x.verification.method },
    'unknown method': x => { x.verification.method = 'manual' },
    'invalid source revision': x => { x.verification.sourceRevision = 'latest' },
    'missing entry point': x => { delete x.verification.entryPoint },
    'blank entry point': x => { x.verification.entryPoint = ' ' },
    'extra proof field': x => { x.verification.extra = true },
    'blank action ref': x => { x.verification.actionAndResult.ref = ' ' },
    'invalid action digest': x => { x.verification.actionAndResult.digest = 'garbage' },
    'partial action artifact': x => { delete x.verification.actionAndResult.digest },
    'missing persistence': x => { delete x.verification.persistence },
    'blank written value ref': x => { x.verification.persistence.writtenValue.ref = ' ' },
    'invalid readback digest': x => { x.verification.persistence.independentReadback.digest = 'garbage' },
    'blank readback method': x => { x.verification.persistence.readbackMethod = ' ' },
    'partial readback artifact': x => { delete x.verification.persistence.independentReadback.ref }
  }
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, () => {
      const evidence = proof('ios'); mutate(evidence)
      assert.equal(validateEvidence(evidence), false, name)
      assert.equal(isVerifiedUserPath(evidence, evidence.verification.sourceRevision), false, name)
      const value = project(); value.platforms = ['ios']
      assert.equal(evaluateMobileVerification(value, ['capabilities/mobile-verification'],
        [evidence, proof('ios', 'e2e')]).status, 'pending', name)
    })
  }
  for (const evidence of [null, undefined, 'receipt', {}, { verification: null }]) {
    await t.test(`partial record ${JSON.stringify(evidence)}`, () => {
      assert.equal(validateEvidence(evidence), false)
      assert.equal(isVerifiedUserPath(evidence, project().sourceRevision), false)
      const value = project(); value.platforms = ['ios']
      assert.equal(evaluateMobileVerification(value, ['capabilities/mobile-verification'],
        [evidence, proof('ios', 'e2e')]).status, 'pending')
    })
  }
})

test('e2e receipts use simulated critique on every platform in the schema and helper', () => {
  for (const platform of PROJECT_PLATFORMS) {
    for (const strength of EVIDENCE_STRENGTHS) {
      const evidence = proof(platform, 'e2e'); evidence.strength = strength
      const expected = strength === 'simulated-critique'
      assert.equal(validateEvidence(evidence), expected, `${platform}/${strength}: schema`)
      assert.equal(isVerifiedUserPath(evidence, project().sourceRevision), expected,
        `${platform}/${strength}: helper`)
      const value = project(); value.handoffs[0].evidence = [evidence]
      assert.equal(validate(value), expected, `${platform}/${strength}: project`)
      evidence.verification.method = 'verify-skill'
      assert.equal(validateEvidence(evidence), true, `${platform}/${strength}: verify-skill`)
      assert.equal(isVerifiedUserPath(evidence, value.sourceRevision), true)
    }
  }
})

test('invalid app.json platform signals cannot suppress mobile reconciliation', async t => {
  for (const appJsonPlatforms of [[], ['watch'], ['web', 'watch'], null, 'web', {}]) {
    await t.test(JSON.stringify(appJsonPlatforms), () => {
      assert.throws(() => inspectProjectPlatforms(['web'], {
        dependencies: [], paths: ['app.json'], appJsonPlatforms
      }), /appJsonPlatforms must be a non-empty array of known project platforms/)
    })
  }
  assert.deepEqual(inspectProjectPlatforms(['web'], {
    dependencies: [], paths: ['app.json'], appJsonPlatforms: undefined
  }), { detected: ['ios', 'android'], missing: ['ios', 'android'], mismatch: true })
  assert.deepEqual(inspectProjectPlatforms(['web'], {
    dependencies: [], paths: ['app.json'], appJsonPlatforms: ['web', 'ios']
  }), { detected: ['web', 'ios'], missing: ['ios'], mismatch: true })
})
