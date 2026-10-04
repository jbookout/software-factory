import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assessBenchmark, observeOwners } from '../scripts/ci-runner-benchmark.mjs'
import { canonicalDigest } from '../src/canonical.mjs'

const sha = 'a'.repeat(40), digest = 'b'.repeat(64)
const now = '2026-10-04T20:00:00Z'
const stamp = seconds => new Date(Date.parse(now) - 3600000 + seconds * 1000).toISOString()
const repo = 'jbookout/doctorcre-app'
const workflow = 'name: CI\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n'
function fixture() {
  const run = (id, seconds, failed, cold) => ({
    id, run_attempt: 1, head_sha: sha, tree_sha: sha, inputDigest: failed ? 'c'.repeat(64) : digest,
    workflowDigest: canonicalDigest(id % 2 ? workflow : workflow.replace('ubuntu-latest', 'trial-4cpu')),
    selector: id % 2 ? 'ubuntu-latest' : 'trial-4cpu', workloadDigest: canonicalDigest(workflow), environmentDigest: digest,
    cacheState: cold ? 'cold' : 'warm', loadDigest: digest,
    created_at: stamp(0), started_at: stamp(10),
    checkRuns: [{ id, head_sha: sha, name: 'test', app: { id: 1 }, status: 'completed',
      conclusion: failed ? 'failure' : 'success', completed_at: stamp(seconds) }], statuses: [],
    tests: [{ id: digest, verdict: failed ? 'failure' : 'success' }],
    parity: Object.fromEntries(['pg', 'browser', 'runtime', 'network', 'artifact', 'checkout', 'sudo', 'loopback'].map(k => [k, { status: 'pass', digest }])),
    hardware: { cpuCount: 4, memoryBytes: 8e9, peakMemoryBytes: 1e9, cpuDigest: digest, osDigest: digest, filesystemDigest: digest, toolchainDigest: digest },
    phases: { setupSeconds: 10, testSeconds: 20, buildSeconds: 5 },
    charge: { usd: 0, overheadUsd: 0, evidenceDigest: digest }, providerFailures: 0,
    lifecycle: { queueToGreenSeconds: failed ? null : seconds, greenToReviewSeconds: null, mergeToLiveSeconds: null }
  })
  return {
    schema: 'ci-runner-experiment/v1', repo, registered_at: stamp(-20), baselineDigest: digest,
    owners: ['carr-system', 'doctorcre-app', 'software-factory'].map(name => ({ repo: `jbookout/${name}`, type: 'User', observed_at: stamp(-30), evidenceDigest: digest })),
    provider: { supportedOwnerTypes: ['User'], labels: ['trial-4cpu'], observed_at: stamp(-30), evidenceDigest: digest,
      pricingDigest: digest, install: { repositories: [repo], permissionsDigest: digest, acceptedPermissionsDigest: digest, productionCredentials: false },
      probe: { repo, label: 'trial-4cpu', passed: true, evidenceDigest: digest }, newSpendUsd: 0, maxTrialUsd: 0 },
    originalSelector: 'ubuntu-latest', candidateSelector: 'trial-4cpu',
    originalWorkflow: workflow, candidateWorkflow: workflow.replace('ubuntu-latest', 'trial-4cpu'),
    requiredChecks: [{ name: 'test', appId: 1 }],
    plannedPairs: Array.from({ length: 10 }, (_, i) => ({ baseline: i * 2 + 1, candidate: i * 2 + 2 })),
    pairs: Array.from({ length: 10 }, (_, i) => ({ baseline: run(i * 2 + 1, 100, i === 9, i < 5), candidate: run(i * 2 + 2, 80, i === 9, i < 5) }))
  }
}
const assess = value => assessBenchmark(value, { now })
test('ten paired successful/failing inputs at exact proposed bar qualify only in shadow', () => {
  const result = assess(fixture())
  assert.equal(result.state, 'qualified-shadow')
  assert.equal(result.gateAuthority, false)
  assert.equal(result.metrics.medianImprovement, .2)
  assert.equal(result.metrics.candidate.p95, 80)
  assert.equal(result.metrics.pairs, 10)
})
test('unsupported existing owner declines provider before considering missing trials', () => {
  const value = fixture(); value.provider.supportedOwnerTypes = ['Organization']; value.pairs = []
  assert.equal(assess(value).state, 'declined')
  assert.equal(assess(value).reason, 'owner-ineligible')
})
for (const [name, mutate, state] of [
  ['missing owner', x => x.owners.pop(), 'unknown'],
  ['stale eligibility', x => x.provider.observed_at = stamp(-8 * 86400), 'unknown'],
  ['label unavailable', x => x.provider.labels = [], 'declined'],
  ['scope widened', x => x.provider.install.repositories.push('jbookout/carr-system'), 'declined'],
  ['unexpected permissions', x => x.provider.install.permissionsDigest = 'c'.repeat(64), 'declined'],
  ['production credentials', x => x.provider.install.productionCredentials = true, 'declined'],
  ['purchase needed', x => x.provider.newSpendUsd = .01, 'declined'],
  ['probe acknowledgement missing', x => delete x.provider.probe.passed, 'unknown'],
  ['probe refusal', x => x.provider.probe.passed = false, 'declined'],
  ['baseline missing', x => delete x.baselineDigest, 'unknown'],
  ['preflight after registration', x => x.provider.observed_at = stamp(-10), 'rejected'],
  ['future verdict', x => x.pairs[0].candidate.checkRuns[0].completed_at = stamp(7200), 'unknown'],
  ['nine pairs', x => x.pairs.pop(), 'unknown'],
  ['unplanned replacement', x => x.pairs[0].candidate.id = 101, 'rejected'],
  ['duplicate run', x => x.pairs[1].candidate.id = 2, 'rejected'],
  ['late registration', x => x.registered_at = stamp(50), 'rejected'],
  ['rerun until green', x => x.pairs[0].candidate.run_attempt = 2, 'rejected'],
  ['changed tree', x => x.pairs[0].candidate.tree_sha = 'c'.repeat(40), 'rejected'],
  ['changed source', x => x.pairs[0].candidate.head_sha = 'c'.repeat(40), 'rejected'],
  ['changed input', x => x.pairs[0].candidate.inputDigest = 'c'.repeat(64), 'rejected'],
  ['warmer cache', x => x.pairs[0].candidate.cacheState = 'warm', 'rejected'],
  ['no cold setup', x => x.pairs.forEach(p => p.baseline.cacheState = p.candidate.cacheState = 'warm'), 'rejected'],
  ['less testing', x => x.candidateWorkflow += '      - run: echo skip\n', 'rejected'],
  ['raised caps', x => x.candidateWorkflow += '    timeout-minutes: 40\n', 'rejected'],
  ['runner-like line in shell block is not a selector', x => {
    x.originalWorkflow = 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          runs-on: ubuntu-latest\n'
    x.candidateWorkflow = x.originalWorkflow.replace('          runs-on: ubuntu-latest', '          runs-on: trial-4cpu')
    for (const p of x.pairs) {
      p.baseline.workflowDigest = canonicalDigest(x.originalWorkflow); p.candidate.workflowDigest = canonicalDigest(x.candidateWorkflow)
      p.baseline.workloadDigest = p.candidate.workloadDigest = canonicalDigest(x.originalWorkflow)
    }
  }, 'rejected'],
  ['invalid YAML does not qualify', x => {
    x.originalWorkflow += 'bad: [\n'; x.candidateWorkflow += 'bad: [\n'
    for (const p of x.pairs) {
      p.baseline.workflowDigest = canonicalDigest(x.originalWorkflow); p.candidate.workflowDigest = canonicalDigest(x.candidateWorkflow)
      p.baseline.workloadDigest = p.candidate.workloadDigest = canonicalDigest(x.originalWorkflow)
    }
  }, 'unknown'],
  ['test inventory lost', x => x.pairs[0].candidate.tests = [], 'unknown'],
  ['bad fixture becomes green', x => x.pairs[9].candidate.tests[0].verdict = 'success', 'rejected'],
  ['missing required check', x => x.pairs[0].candidate.checkRuns = [], 'unknown'],
  ['empty required contract', x => x.requiredChecks = [], 'unknown'],
  ['invalid check acknowledgement', x => delete x.pairs[0].candidate.checkRuns[0].status, 'unknown'],
  ['workflow artifact differs', x => x.pairs[0].candidate.workflowDigest = 'c'.repeat(64), 'rejected'],
  ['actual label differs', x => x.pairs[0].candidate.selector = 'other', 'rejected'],
  ['setup hidden from timing', x => x.pairs[0].candidate.phases.setupSeconds = 1000, 'unknown'],
  ['missing verdict timestamp', x => delete x.pairs[0].candidate.checkRuns[0].completed_at, 'unknown'],
  ['cancelled', x => x.pairs[0].candidate.checkRuns[0].conclusion = 'cancelled', 'rejected'],
  ['pending', x => { x.pairs[0].candidate.checkRuns[0].status = 'in_progress'; x.pairs[0].candidate.checkRuns[0].conclusion = null }, 'unknown'],
  ['wrong producer', x => x.pairs[0].candidate.checkRuns[0].app.id = 2, 'unknown'],
  ['partial charge', x => delete x.pairs[0].candidate.charge.overheadUsd, 'unknown'],
  ['cost exceeds ceiling', x => x.pairs[0].candidate.charge.usd = .01, 'rejected'],
  ['provider-specific failure', x => x.pairs[0].candidate.providerFailures = 1, 'rejected'],
  ['below twenty percent', x => x.pairs.forEach(p => p.candidate.checkRuns[0].completed_at = stamp(81)), 'rejected'],
  ['tail worsens', x => x.pairs[0].candidate.checkRuns[0].completed_at = stamp(101), 'rejected'],
  ['queue dominates despite fast steps', x => x.pairs.forEach(p => p.candidate.checkRuns[0].completed_at = stamp(120)), 'rejected'],
  ['only passing controls', x => x.pairs[9] = structuredClone(x.pairs[8]), 'rejected'],
]) test(name, () => { const x = fixture(); mutate(x); assert.equal(assess(x).state, state, name); assert.ok(assess(x).nextAction) })
for (const field of ['pg', 'browser', 'runtime', 'network', 'artifact', 'checkout', 'sudo', 'loopback']) {
  test(`${field} parity differs`, () => { const x = fixture(); x.pairs[0].candidate.parity[field].digest = 'c'.repeat(64); assert.equal(assess(x).state, 'rejected') })
}
test('unknown can recover after evidence arrives without changing or disposing earlier evidence', () => {
  const x = fixture(); const original = JSON.stringify(x); const partial = structuredClone(x); partial.pairs.pop()
  assert.equal(assess(partial).state, 'unknown'); assert.equal(assess(x).state, 'qualified-shadow'); assert.equal(JSON.stringify(x), original)
})
test('downstream timings are separate distributions with missing evidence retained', () => {
  const x = fixture(); x.pairs[0].baseline.lifecycle.greenToReviewSeconds = 12
  const result = assess(x)
  assert.equal(result.metrics.downstream.baseline.greenToReviewSeconds.samples, 1)
  assert.equal(result.metrics.downstream.baseline.greenToReviewSeconds.missing, 9)
  assert.equal(result.metrics.downstream.baseline.greenToReviewSeconds.status, 'unknown')
  assert.equal(result.metrics.downstream.candidate.mergeToLiveSeconds.median, null)
})
test('owner observation uses only REST GET and isolates all result faults', async () => {
  const faults = [() => ({ status: 0, stdout: '' }), () => ({ status: 1, stderr: 'CANARY_SECRET' }),
    () => ({ status: 0, stdout: '{}' }), () => { throw Error('CANARY_SECRET') },
    () => ({ status: 0, stdout: JSON.stringify({ full_name: repo, owner: { type: 'Robot' } }) })]
  for (const fault of faults) {
    let count = 0
    const result = await observeOwners({ now, run: args => { assert.equal(args[0], 'api'); assert.equal(args[1], '--method'); assert.equal(args[2], 'GET'); count++; return count === 2 ? fault() : { status: 0, stdout: JSON.stringify({ full_name: `jbookout/${['carr-system', 'doctorcre-app', 'software-factory'][count - 1]}`, owner: { type: 'User' } }) } } })
    assert.equal(result.owners.filter(x => x.state === 'observed').length, 2)
    assert.equal(result.state, 'unknown'); assert.ok(!JSON.stringify(result).includes('CANARY_SECRET'))
  }
})
test('CLI persisted bytes and errors never echo input, nested PII, URL secrets or subprocess stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-shadow-')), input = join(dir, 'input.json'), output = join(dir, 'report.json')
  const x = fixture(); x.extra = { client: 'CANARY_CLIENT', url: 'https://user:CANARY_SECRET@invalid.test/?token=CANARY_SECRET', credential: 'CANARY_SECRET\nquoted="CANARY_SECRET"' }
  x.pairs[0].candidate.hardware.extra = { client: 'CANARY_CLIENT', credential: 'CANARY_SECRET' }
  x.pairs[0].candidate.checkRuns[0].output = { text: 'CANARY_SECRET' }
  writeFileSync(input, JSON.stringify(x))
  const cli = (...args) => spawnSync(process.execPath, ['scripts/ci-runner-benchmark.mjs', ...args], { encoding: 'utf8' })
  const result = cli('--input', input, '--output', output, '--now', now)
  assert.equal(result.status, 0)
  for (const bytes of [result.stdout, result.stderr, readFileSync(output, 'utf8')]) assert.doesNotMatch(bytes, /CANARY_|invalid.test/)
  const first = readFileSync(output, 'utf8'); assert.equal(cli('--input', input, '--output', output, '--now', now).status, 2); assert.equal(readFileSync(output, 'utf8'), first)
  writeFileSync(input, 'CANARY_SECRET'); const bad = cli('--input', input); assert.equal(bad.status, 2); assert.doesNotMatch(bad.stdout + bad.stderr, /CANARY_/)
  const link = join(dir, 'link'); symlinkSync(input, link); assert.equal(cli('--input', link).status, 2)
  writeFileSync(input, Buffer.alloc(10 * 1024 * 1024 + 1)); assert.equal(cli('--input', input).status, 2)
  assert.equal(cli('--enable').status, 2)
  const fakeGh = join(dir, 'gh'), ownerOutput = join(dir, 'owner-error.json')
  writeFileSync(fakeGh, `#!${process.execPath}\nprocess.stderr.write('CANARY_SECRET\\n'); process.stdout.write('{}');\n`, { mode: 0o755 })
  const refused = spawnSync(process.execPath, ['scripts/ci-runner-benchmark.mjs', '--observe-owners', '--output', ownerOutput],
    { encoding: 'utf8', env: { ...process.env, PATH: dir } })
  assert.equal(refused.status, 2)
  assert.doesNotMatch(refused.stdout + refused.stderr + readFileSync(ownerOutput, 'utf8'), /CANARY_/)
})
