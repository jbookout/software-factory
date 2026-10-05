import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPinnedBuildContext, replaySteeringRemoval } from '../src/model-room.mjs'
import { canonicalDigest } from '../src/canonical.mjs'

const sha = text => createHash('sha256').update(text).digest('hex')
const line = 'Prefer the smallest dependable solution.'
const text = `# Working rules\n- ${line} Complexity must buy measured value.\n- Credentials stay private.\n`
const context = createPinnedBuildContext([{ source_revision: 'a'.repeat(40), path: 'AGENTS.md',
  excerpt: text, content_digest: `sha256:${sha(text)}` }])
const route = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }
const tasks = ['launch', 'delivery'].map(id => ({ id, recordedSource: { ref: `${id}.json`,
  digest: sha(id) }, role: 'Platform Engineer', evidenceContract: 'Read the job receipt before claiming completion.',
  checks: ['job-specific startup', 'remote source readback'], input: id }))
const metrics = { taskSuccess: true, falseClaims: 0, ruleViolations: 0, requiredSourceDiscovery: true }

function world({ observe = () => metrics, executeEdit = r => r, judge = observe } = {}) {
  const artifacts = new Map(tasks.map(t => [t.recordedSource.ref, Buffer.from(t.id)]))
  const requests = []
  const execute = async request => {
    requests.push(structuredClone(request))
    const response = executeEdit({ requestDigest: request.digest, routeReadback: route, result: 'response' })
    const bytes = Buffer.from(JSON.stringify(response))
    const ref = `${request.trialId}.json`
    artifacts.set(ref, bytes)
    return { ref, digest: sha(bytes) }
  }
  return { requests, artifacts, options: { context, path: 'AGENTS.md', line, boundary: 'guidance',
    tasks, route, repetitions: 2, execute, judge, evaluatorDigest: sha('trusted evaluator'),
    readArtifact: async ref => artifacts.get(ref) ?? null } }
}

test('paired replay changes only the selected sentence and compares four behavioral dimensions', async () => {
  const w = world()
  const result = await replaySteeringRemoval(w.options)
  assert.equal(w.requests.length, 8)
  for (let n = 0; n < w.requests.length; n += 2) {
    const [a, b] = w.requests.slice(n, n + 2).sort((a, b) => a.arm === 'baseline' ? -1 : 1)
    assert.equal(a.context.contracts[0].excerpt, text)
    assert.equal(b.context.contracts[0].excerpt, text.replace(line, ''))
    assert.deepEqual(a.task, b.task)
    assert.deepEqual(a.route, b.route)
    assert.equal(a.task.role, 'Platform Engineer')
  }
  assert.equal(result.decision, 'propose_removal')
  assert.equal(result.scope, 'bounded_model_relative')
  assert.deepEqual(result.regressions, [])
  assert.equal(result.pairs.length, 4)
})

for (const [dimension, bad] of Object.entries({ taskSuccess: false, falseClaims: 1,
  ruleViolations: 1, requiredSourceDiscovery: false })) {
  test(`removal degrading ${dimension} keeps the line`, async () => {
    const w = world({ observe: ({ request }) => request.arm === 'removed' ? { ...metrics, [dimension]: bad } : metrics })
    const result = await replaySteeringRemoval(w.options)
    assert.equal(result.decision, 'keep')
    assert.ok(result.regressions.some(r => r.dimension === dimension))
  })
}

test('two equally failed arms and incomplete discovery evidence cannot justify pruning', async () => {
  for (const value of [{ ...metrics, taskSuccess: false }, { ...metrics, requiredSourceDiscovery: null }, {}]) {
    const result = await replaySteeringRemoval(world({ observe: () => value }).options)
    assert.equal(result.decision, 'insufficient_evidence')
  }
})

test('copied, unbound, wrong-model, unreadable and malformed receipts never count as trials', async () => {
  for (const edit of [r => ({ ...r, requestDigest: 'b'.repeat(64) }),
    r => ({ ...r, routeReadback: { ...route, model: 'other' } }), r => ({ ...r, result: null })]) {
    const w = world({ executeEdit: edit })
    const result = await replaySteeringRemoval(w.options)
    assert.equal(result.decision, 'insufficient_evidence')
    assert.ok(result.failures.length)
  }
  const w = world()
  w.options.execute = async () => ({ ref: 'missing.json', digest: sha('missing') })
  assert.equal((await replaySteeringRemoval(w.options)).decision, 'insufficient_evidence')
})

test('hard boundaries are kept even when the same gate makes both arms pass', async () => {
  for (const boundary of ['authority', 'credential', 'evidence_integrity']) {
    const w = world()
    const result = await replaySteeringRemoval({ ...w.options, boundary })
    assert.equal(result.decision, 'keep_boundary')
    assert.equal(w.requests.length, 8)
  }
})

test('ambiguous removals, invalid bounds, changed sources and bad contexts refuse before execution', async () => {
  const w = world()
  for (const edit of [{ line: 'missing' }, { repetitions: 0 }, { repetitions: 11 }, { boundary: 'unknown' },
    { tasks: [tasks[0], tasks[0]] }, { context: { ...context, digest: 'bad' } },
    { context: createPinnedBuildContext([{ ...context.contracts[0], excerpt: `${text}${line}`,
      content_digest: `sha256:${sha(`${text}${line}`)}` }]) }]) {
    await assert.rejects(replaySteeringRemoval({ ...w.options, ...edit }))
  }
  w.artifacts.set('launch.json', Buffer.from('changed'))
  await assert.rejects(replaySteeringRemoval(w.options), /recorded source/)
  assert.equal(w.requests.length, 0)
})

test('a failed invocation is recorded without retry and cannot produce a no-op finding', async () => {
  const w = world()
  let calls = 0
  const result = await replaySteeringRemoval({ ...w.options, execute: async () => { calls++; throw Error('unavailable') } })
  assert.equal(calls, 1)
  assert.equal(result.decision, 'insufficient_evidence')
  assert.equal(result.failures.length, 1)
})

test('a single-pair failure preserves dispatch identity and returns insufficient evidence', async () => {
  const w = world()
  const result = await replaySteeringRemoval({ ...w.options, tasks: [tasks[0]], repetitions: 1,
    execute: async () => { throw Error('unavailable') } })
  assert.equal(result.decision, 'insufficient_evidence')
  assert.equal(result.pairs[0].baseline.status, 'failed')
  assert.ok(result.pairs[0].baseline.trialId)
  assert.equal(result.pairs[0].removed, null)
  assert.equal(result.failures.length, 1)
})

test('a timed-out trial aborts and stops the experiment without starting another model call', async () => {
  const w = world()
  let calls = 0, signal
  const result = await replaySteeringRemoval({ ...w.options, timeoutMs: 10,
    execute: async (_, options) => { calls++; signal = options.signal; return new Promise(() => {}) } })
  assert.equal(calls, 1)
  assert.equal(signal.aborted, true)
  assert.equal(result.decision, 'insufficient_evidence')
  assert.equal(result.failures[0].reason, 'trial_timeout_observe_before_retry')
})

test('a behavioral improvement also counts as contribution and keeps the line', async () => {
  const w = world({ observe: ({ request }) => ({ ...metrics,
    falseClaims: request.arm === 'baseline' ? 1 : 0 }) })
  const result = await replaySteeringRemoval(w.options)
  assert.equal(result.decision, 'keep')
  assert.ok(result.changes.length)
})

test('the trial deadline also bounds a stalled independent evaluator', async () => {
  const w = world({ judge: () => new Promise(() => {}) })
  const result = await replaySteeringRemoval({ ...w.options, timeoutMs: 10 })
  assert.equal(result.failures[0].reason, 'trial_timeout_observe_before_retry')
  assert.equal(w.requests.length, 1)
})

for (const stage of ['execute', 'readArtifact', 'judge']) {
  test(`synchronous ${stage} cannot pass an expired shared trial budget`, async () => {
    const w = world()
    const original = w.options[stage]
    w.options[stage] = (...args) => {
      if (stage !== 'readArtifact' || args[0].endsWith('-baseline.json')) {
        const end = performance.now() + 40
        while (performance.now() < end) {}
      }
      return original(...args)
    }
    const result = await replaySteeringRemoval({ ...w.options, timeoutMs: 10 })
    assert.equal(w.requests.length, 1)
    assert.equal(result.failures[0]?.reason, 'trial_timeout_observe_before_retry')
    assert.equal(result.decision, 'insufficient_evidence')
  })
}

for (const mutation of ['context', 'tasks']) {
  test(`source reads cannot mutate reported ${mutation} identity or completion`, async () => {
    const w = world()
    w.options.context = structuredClone(context)
    w.options.tasks = structuredClone(tasks)
    const reader = w.options.readArtifact
    w.options.readArtifact = async ref => {
      if (ref === 'launch.json') {
        if (mutation === 'context') w.options.context.digest = 'changed-during-source-read'
        else w.options.tasks.pop()
      }
      return reader(ref)
    }
    const result = await replaySteeringRemoval(w.options)
    assert.equal(result.baselineContextDigest, context.digest)
    assert.equal(result.pairs.length, tasks.length * 2)
    assert.equal(result.decision, 'propose_removal')
    assert.ok(w.requests.every(r => r.arm !== 'baseline' || r.context.digest === context.digest))
  })
}

for (const id of [1, null, undefined]) {
  test(`task ID ${String(id)} is rejected before source reads or execution`, async () => {
    const w = world()
    let reads = 0
    await assert.rejects(replaySteeringRemoval({ ...w.options,
      tasks: [{ ...tasks[0], id }, { ...tasks[1], id: String(id) }],
      readArtifact: async ref => { reads++; return w.options.readArtifact(ref) }
    }), /invalid recorded task id/)
    assert.equal(reads, 0)
    assert.equal(w.requests.length, 0)
  })
}

test('a reused adapter descriptor cannot rewrite the earlier arm artifact binding', async () => {
  const w = world()
  const descriptor = {}
  const execute = w.options.execute
  const result = await replaySteeringRemoval({ ...w.options, execute: async request => {
    Object.assign(descriptor, await execute(request))
    return descriptor
  } })
  for (const pair of result.pairs) {
    for (const arm of ['baseline', 'removed']) {
      const bytes = w.artifacts.get(pair[arm].artifact.ref)
      assert.equal(JSON.parse(bytes).requestDigest, pair[arm].requestDigest)
      assert.equal(sha(bytes), pair[arm].artifact.digest)
    }
  }
})

test('the evaluator identity is required and changes experiment and trial identities', async () => {
  const w = world()
  const a = await replaySteeringRemoval({ ...w.options, runId: 'fixed' })
  const b = await replaySteeringRemoval({ ...w.options, runId: 'fixed', evaluatorDigest: sha('changed evaluator') })
  assert.notEqual(a.experimentDigest, b.experimentDigest)
  assert.equal(a.evaluatorDigest, w.options.evaluatorDigest)
  assert.notEqual(a.pairs[0].baseline.requestDigest, b.pairs[0].baseline.requestDigest)
  await assert.rejects(replaySteeringRemoval({ ...w.options, evaluatorDigest: undefined }))
})

function cliFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steering-cli-'))
  execFileSync('git', ['init', '-q', root])
  fs.writeFileSync(path.join(root, 'AGENTS.md'), text)
  execFileSync('git', ['add', 'AGENTS.md'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture'], { cwd: root })
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  for (const task of tasks) fs.writeFileSync(path.join(root, task.recordedSource.ref), task.input)
  const plan = { steering: { root, sourceRevision: revision, path: 'AGENTS.md', startLine: 1, endLine: 4 },
    line, boundary: 'guidance', tasks, route, repetitions: 1, artifactRoot: root }
  fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan))
  fs.writeFileSync(path.join(root, 'adapter.mjs'), `
    import fs from 'node:fs/promises'; import { createHash } from 'node:crypto';
    export async function execute(r) {
      const bytes = JSON.stringify({requestDigest:r.digest, routeReadback:r.route, result:'observed'});
      const ref = r.trialId + '.json'; await fs.writeFile(new URL(ref, import.meta.url), bytes);
      return {ref,digest:createHash('sha256').update(bytes).digest('hex')};
    }
    export function judge() { return ${JSON.stringify(metrics)}; }
  `)
  const args = ['scripts/steering-removal.mjs', path.join(root, 'plan.json'),
    path.join(root, 'adapter.mjs'), path.join(root, 'report.json')]
  return { root, args }
}

test('replay CLI loads pinned steering and writes a comparison without editing it', () => {
  const { root, args } = cliFixture()
  const summary = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }))
  assert.equal(summary.decision, 'propose_removal')
  const report = JSON.parse(fs.readFileSync(path.join(root, 'report.json')))
  assert.equal(report.pairs.length, 2)
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), text)
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), /Command failed/)
})

test('an existing report prevents all evaluator initialization', () => {
  const { root, args } = cliFixture()
  const pending = JSON.stringify({ status: 'pending', runId: 'existing' })
  fs.writeFileSync(args[3], pending)
  fs.appendFileSync(args[2], `\nawait fs.appendFile(new URL('initialized', import.meta.url), 'initialized');\n`)
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }))
  assert.equal(fs.existsSync(path.join(root, 'initialized')), false)
  assert.equal(fs.readFileSync(args[3], 'utf8'), pending)
})

test('interrupted CLI retains generated identity, dispatches and completed receipts for observation', () => {
  const { root, args } = cliFixture()
  const adapter = fs.readFileSync(args[2], 'utf8').replace('const bytes =', `
    await fs.appendFile(new URL('dispatches', import.meta.url), r.trialId + '\\n');
    if (r.arm === 'removed') process.exit(23);
    const bytes =`)
  fs.writeFileSync(args[2], adapter)
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), e => e.status === 23)
  const report = JSON.parse(fs.readFileSync(args[3], 'utf8'))
  assert.equal(report.status, 'pending')
  assert.ok(report.runId)
  assert.match(report.experimentDigest, /^[0-9a-f]{64}$/)
  const pair = report.pairs[0]
  assert.equal(pair.baseline.status, 'completed')
  assert.deepEqual(pair.baseline.metrics, metrics)
  assert.equal(pair.removed.status, 'dispatched')
  const dispatches = fs.readFileSync(path.join(root, 'dispatches'), 'utf8')
  assert.deepEqual(dispatches.trim().split('\n'), [pair.baseline.trialId, pair.removed.trialId])
  assert.ok(pair.baseline.trialId.startsWith(report.experimentDigest))
  const bytes = fs.readFileSync(path.join(root, pair.baseline.artifact.ref))
  assert.equal(sha(bytes), pair.baseline.artifact.digest)
  assert.equal(JSON.parse(bytes).requestDigest, pair.baseline.requestDigest)
  assert.equal(report.baselineContextDigest, createPinnedBuildContext([
    { ...context.contracts[0], source_revision: JSON.parse(fs.readFileSync(args[1])).steering.sourceRevision }
  ]).digest)
  const before = canonicalDigest(report)
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }))
  assert.equal(canonicalDigest(JSON.parse(fs.readFileSync(args[3], 'utf8'))), before)
  assert.equal(fs.readFileSync(path.join(root, 'dispatches'), 'utf8'), dispatches)
})
