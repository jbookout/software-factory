import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createArtifactReader } from 'software-factory'
import * as e2e from '../../capabilities/agentic-ui-evaluation/wrapper.mjs'

// Synthetic normalized receipts exercise the wrapper's rules. They are not a
// live e2e run; live qualification needs the attended ChatGPT login.
const sha = text => createHash('sha256').update(text).digest('hex')
const brokenBuild = { sourceCommit: 'a'.repeat(40), buildDigest: sha('broken build') }
const cleanBuild = { sourceCommit: 'b'.repeat(40), buildDigest: sha('repaired build') }
const manifest = {
  defects: [
    { id: 'lost-save', route: '/tasks/new', assertion: "expect(list).toContainText('Buy milk')" },
    { id: 'dead-filter', route: '/tasks?filter=done', assertion: "expect(rows).toHaveCount(1)" }
  ],
  traps: [
    { id: 'blank-refusal', kind: 'intended-refusal', route: '/tasks/new?title=' },
    { id: 'empty-state', kind: 'empty-state', route: '/tasks?filter=archived' },
    { id: 'denied-admin', kind: 'permission-denied', route: '/admin' },
    { id: 'help-tab', kind: 'new-tab', route: '/help' }
  ]
}
const repro = (defect, build = brokenBuild, outcome = 'failed') => ({ test: { ref: `repro-${defect.id}.spec.ts`,
  digest: sha(`repro ${defect.id}`) }, binding: { ...build }, outcome, assertion: defect.assertion,
  assertionKind: 'deterministic', route: defect.route })
const charters = [{ id: 'save-journey', stateNamespace: 'run-1/save' }, { id: 'filter-bash', stateNamespace: 'run-1/filter' }]
const trapRuns = candidate => manifest.traps.map(trap => ({ id: trap.id, binding: candidate, outcome: 'passed' }))

function findings() {
  return [
    ...manifest.defects.map((defect, index) => ({ id: `f-${defect.id}`, charter: charters[index].id,
      story: `agent saw ${defect.id}`, explanation: null, repro: repro(defect) })),
    { id: 'f-crash', charter: 'save-journey', story: 'navigation crashed after login', explanation: null,
      repro: { ...repro(manifest.defects[0]), outcome: 'blocked', assertion: null } },
    { id: 'f-screenshot', charter: 'filter-bash', story: 'button looked misaligned in a screenshot', explanation: null, repro: null },
    { id: 'f-refusal', charter: 'save-journey', story: 'blank title is refused',
      explanation: { expectation: 'blank titles are refused by design', observation: 'refusal message shown' },
      repro: { ...repro({ id: 'refusal', route: '/tasks/new?title=', assertion: 'expect(error).toBeVisible()' }) } }
  ]
}
async function archive() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-archive-'))
  const refs = []
  for (const name of ['report.json', 'trace.zip']) {
    await fs.writeFile(path.join(root, name), `sanitized ${name}`)
    refs.push({ ref: name, digest: sha(`sanitized ${name}`) })
  }
  return { root, refs, readArtifact: createArtifactReader(root) }
}
async function qualification(edit = x => x) {
  const store = await archive()
  const input = await edit({
    manifest, broken: { candidate: brokenBuild, charters, findings: findings(), trapRuns: trapRuns(brokenBuild) },
    repaired: { candidate: cleanBuild, reruns: manifest.defects.map(d => ({ ...repro(d, cleanBuild, 'passed') })), trapRuns: trapRuns(cleanBuild) },
    replay: { candidate: brokenBuild, providerInvocations: 0, reruns: manifest.defects.map(d => repro(d)), trapRuns: trapRuns(brokenBuild) },
    archive: { refs: store.refs, readArtifact: store.readArtifact }
  }, store)
  return e2e.qualifyAgenticEvaluation(input)
}

test('e2e pin, license and telemetry switch are fixed on every invocation', () => {
  assert.deepEqual(e2e.E2E_PIN, { package: 'e2e', version: '0.16.0', license: 'Apache-2.0',
    sourceRevision: 'a0ee3e9061b666fa3dd43e7dcc8e1a5da47362d6' })
  for (const env of [{}, { E2E_TELEMETRY_DISABLED: '0', PATH: '/bin' }]) {
    const out = e2e.e2eEnvironment(env)
    assert.equal(out.E2E_TELEMETRY_DISABLED, '1')
    assert.notEqual(out, env)
  }
  for (const mode of e2e.E2E_MODES) assert.equal(e2e.e2eEnvironment({}, mode).E2E_TELEMETRY_DISABLED, '1')
  assert.deepEqual(e2e.E2E_MODES, ['run', 'explore', 'bug-bash', 'mcp', 'replay'])
  assert.throws(() => e2e.e2eEnvironment({}, 'publish'), /unknown e2e mode/)
})

test('model-backed runs are attended only and block on login, missing expiry, failed refresh or near expiry', () => {
  const now = Date.parse('2026-10-04T00:00:00Z')
  const healthy = { status: 'ok', expiresAt: '2026-10-10T00:00:00Z', refreshCheck: 'passed' }
  assert.equal(e2e.attendedEvaluationStatus({ attended: true, health: healthy, now }).status, 'ready')
  for (const [input, pattern] of [
    [{ attended: false, health: healthy }, /attended-evaluation checkpoint/],
    [{ attended: true, health: { ...healthy, status: 'LOGIN_REQUIRED' } }, /LOGIN_REQUIRED/],
    [{ attended: true, health: { ...healthy, expiresAt: undefined } }, /missing expiry/],
    [{ attended: true, health: { ...healthy, refreshCheck: 'failed' } }, /refresh health check failed/],
    [{ attended: true, health: { ...healthy, expiresAt: '2026-10-04T06:00:00Z' } }, /expires/]
  ]) {
    const status = e2e.attendedEvaluationStatus({ ...input, now })
    assert.equal(status.status, 'blocked')
    assert.match(status.reason, pattern)
    assert.equal(status.action, 'Sign in to e2e with ChatGPT (attended)')
  }
  for (const health of [{ ...healthy, accessToken: 'secret' }, { ...healthy, provider: { access_token: 'x' } },
    { ...healthy, sessions: [{ cookie: 'x' }] }])
    assert.throws(() => e2e.attendedEvaluationStatus({ attended: true, now, health }), /credential contents/)
})

test('a finding counts only when its repro fails with an assertion on the exact candidate', () => {
  const result = e2e.triageFindings({ candidate: brokenBuild, charters, findings: findings() })
  assert.deepEqual(result.confirmed.map(f => f.id), ['f-lost-save', 'f-dead-filter'])
  assert.deepEqual(result.rejected.map(f => [f.id, f.reason]),
    [['f-refusal', 'explained non-bug: blank titles are refused by design / refusal message shown']])
  assert.deepEqual(result.discarded.map(f => [f.id, f.reason]),
    [['f-crash', 'blocked run (auth/startup/navigation) is not a confirmed bug'], ['f-screenshot', 'no failing repro']])
  assert.ok([...result.confirmed, ...result.rejected, ...result.discarded].every(f => f.evidenceStrength === 'simulated-critique'))
  const otherBuild = e2e.triageFindings({ candidate: cleanBuild, charters, findings: findings() })
  assert.deepEqual(otherBuild.confirmed, [])
  assert.match(otherBuild.discarded.find(f => f.id === 'f-lost-save').reason, /not on the exact candidate/)
  const shared = e2e.triageFindings({ candidate: brokenBuild, findings: findings(),
    charters: charters.map(c => ({ ...c, stateNamespace: 'run-1/shared' })) })
  assert.match(shared.blocked, /charters share mutable state/)
})

test('qualification: every planted defect caught, no trap flagged, repair passes, zero-call replay, evidence survives', async () => {
  const result = await qualification()
  assert.deepEqual(result.reasons, [])
  assert.equal(result.status, 'qualified')
  assert.equal(result.pilot, 'non-blocking')
  assert.equal(result.evidenceStrength, 'simulated-critique')
})

test('qualification disqualifies missed defects, flagged traps, missing repros, lost evidence and replay model calls', async () => {
  for (const [edit, pattern] of [
    [input => ({ ...input, broken: { ...input.broken, findings: input.broken.findings.filter(f => f.id !== 'f-dead-filter') } }), /planted defect dead-filter missed/],
    [input => ({ ...input, broken: { ...input.broken, findings: input.broken.findings.map(f => f.id === 'f-refusal'
      ? { ...f, explanation: null } : f) } }), /trap blank-refusal flagged/],
    [input => ({ ...input, broken: { ...input.broken, findings: input.broken.findings.map(f => f.id === 'f-lost-save'
      ? { ...f, repro: null } : f) } }), /planted defect lost-save missed/],
    [input => ({ ...input, repaired: { ...input.repaired, reruns: input.repaired.reruns.slice(1) } }), /lost-save not rerun passing on the repaired build/],
    [input => ({ ...input, repaired: { ...input.repaired, reruns: input.repaired.reruns.map(r => ({ ...r, outcome: 'failed' })) } }), /not rerun passing/],
    [input => ({ ...input, repaired: { ...input.repaired, candidate: brokenBuild } }), /repaired build must differ/],
    [input => ({ ...input, replay: { ...input.replay, providerInvocations: 1 } }), /model call during replay/],
    [input => ({ ...input, replay: { ...input.replay, providerInvocations: undefined } }), /model call during replay/],
    [input => ({ ...input, replay: { ...input.replay, reruns: input.replay.reruns.map(r => ({ ...r, assertionKind: 'model-judged' })) } }), /deterministic/],
    [input => ({ ...input, replay: { ...input.replay, reruns: input.replay.reruns.map(r => ({ ...r, outcome: 'passed' })) } }), /replay changed the outcome/],
    [input => ({ ...input, broken: { ...input.broken, trapRuns: [] } }), /trap blank-refusal not exercised/],
    [input => ({ ...input, repaired: { ...input.repaired, trapRuns: trapRuns(brokenBuild) } }), /trap blank-refusal not exercised/],
    [input => ({ ...input, replay: { ...input.replay, trapRuns: [] } }), /trap blank-refusal not exercised/],
    [async (input, store) => { await fs.unlink(path.join(store.root, 'trace.zip')); return input }, /lost evidence: unreadable: trace.zip/],
    [async (input, store) => { await fs.writeFile(path.join(store.root, 'report.json'), 'rewritten'); return input },
      /lost evidence: digest mismatch: report.json/]
  ]) {
    const result = await qualification(edit)
    assert.equal(result.status, 'disqualified', pattern.source)
    assert.match(result.reasons.join('\n'), pattern)
  }
})

test('published report normalization distinguishes assertions from tool failures and binds each repro', () => {
  const manifest = { defects: [{ id: 'save', testTitle: 'save', route: '/new', assertion: 'save persists' }],
    traps: [{ id: 'deny', testTitle: 'deny', route: '/admin', expectation: 'permission denied' }] }
  const result = (title, status, error) => ({ id: title, titlePath: [title], selected: true,
    status, attempts: [{ steps: [], ...(error ? { error } : {}) }] })
  const report = { schemaVersion: 'report-1', run: { runner: { version: e2e.E2E_PIN.version }, errors: [], results: [
    result('save', 'failed', { code: 'ASSERTION_FAILED', category: 'test', phase: 'body' }), result('deny', 'passed') ] } }
  const normalize = report => e2e.normalizeE2eReport({ report, candidate: brokenBuild, manifest,
    test: { ref: 'journeys.e2e.mts', digest: sha('suite') } })
  const normalized = normalize(report)
  assert.equal(normalized.reruns[0].outcome, 'failed')
  assert.equal(normalized.reruns[0].test.ref, 'journeys.e2e.mts#save')
  assert.equal(normalized.trapRuns[0].outcome, 'passed')
  assert.equal(e2e.triageFindings(normalized).confirmed.length, 1)
  assert.equal(e2e.triageFindings(normalized).rejected.length, 1)
  for (const code of ['LOGIN_REQUIRED', 'ENGINE_FAILURE', 'ERROR', 'OPERATION_TIMEOUT']) {
    const changed = structuredClone(report)
    changed.run.results[0].attempts[0].error.code = code
    assert.equal(normalize(changed).reruns[0].outcome, 'blocked')
  }
  for (const mutate of [
    r => { r.run.runner.version = '0.15.1' },
    r => { r.run.results.pop() },
    r => { r.run.results[0].selected = false },
    r => { r.run.errors.push({ code: 'ENGINE_FAILURE' }) },
    r => { r.run.results[0].attempts[0].steps.push({ kind: 'agent' }) },
  ]) {
    const changed = structuredClone(report); mutate(changed)
    assert.throws(() => normalize(changed))
  }
})

test('qualification network guard counts rejected fetch, HTTP and HTTPS provider attempts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-provider-counter-'))
  const log = path.join(root, 'calls.log')
  await fs.writeFile(log, 'counter-start\n')
  const guard = fileURLToPath(new URL('../../capabilities/agentic-ui-evaluation/no-provider.mjs', import.meta.url))
  await promisify(execFile)(process.execPath, ['--import', guard, '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import http from 'node:http'; import https from 'node:https';
    assert.throws(() => fetch('https://example.invalid/model'), /forbidden/);
    assert.throws(() => http.get('http://example.invalid/model'), /forbidden/);
    assert.throws(() => https.request('https://example.invalid/model'), /forbidden/);
  `], { env: { PATH: process.env.PATH, PROVIDER_CALL_LOG: log } })
  assert.equal((await fs.readFile(log, 'utf8')).split('\n').filter(line => line === 'external-invocation').length, 3)
})

test('qualification refuses an empty defect manifest, an empty trap list and an empty archive', async () => {
  const result = await e2e.qualifyAgenticEvaluation({ manifest: { defects: [], traps: [] },
    broken: { candidate: brokenBuild, findings: [] }, repaired: { candidate: cleanBuild, reruns: [] },
    replay: { reruns: [], providerInvocations: 0 }, archive: { refs: [], readArtifact: () => null } })
  assert.equal(result.status, 'disqualified')
  for (const pattern of [/no planted defect/, /no trap/, /no archived evidence/]) assert.match(result.reasons.join('\n'), pattern)
})

test('a trap on the route it guards is not flagged by the correct defect finding on that route', async () => {
  const [defect] = manifest.defects
  const result = await qualification(input => ({ ...input,
    manifest: { defects: [defect], traps: [{ id: 'blank-refusal', kind: 'intended-refusal', route: defect.route }] },
    broken: { ...input.broken, findings: input.broken.findings.filter(f => f.id !== 'f-dead-filter') },
    repaired: { ...input.repaired, reruns: input.repaired.reruns.slice(0, 1) },
    replay: { ...input.replay, reruns: input.replay.reruns.slice(0, 1) } }))
  assert.deepEqual(result.reasons, [])
  assert.equal(result.status, 'qualified')
  const flagged = await qualification(input => ({ ...input,
    manifest: { defects: [defect], traps: [{ id: 'blank-refusal', kind: 'intended-refusal', route: defect.route }] },
    broken: { ...input.broken, findings: [...input.broken.findings.filter(f => f.id !== 'f-dead-filter'),
      { id: 'f-false', charter: 'save-journey', story: 'refusal looked like a bug', explanation: null,
        repro: { ...repro(defect), test: { ref: 'repro-false.spec.ts', digest: sha('false') }, assertion: 'expect(error).toBeHidden()' } }] },
    repaired: { ...input.repaired, reruns: input.repaired.reruns.slice(0, 1) },
    replay: { ...input.replay, reruns: input.replay.reruns.slice(0, 1) } }))
  assert.equal(flagged.status, 'disqualified')
  assert.match(flagged.reasons.join('\n'), /trap blank-refusal flagged/)
})
