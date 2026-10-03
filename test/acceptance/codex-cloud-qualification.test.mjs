import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { qualifyCodexCloud } from 'software-factory/codex-cloud-qualification'

// A real subprocess at the CLI seam; no network, account or model calls.
async function fixture(scenario = 'no-environment') {
  const dir = await mkdtemp(join(tmpdir(), 'codex-cloud-qualification-'))
  const executable = join(dir, 'fake-codex.mjs')
  const calls = join(dir, 'calls.jsonl')
  await writeFile(executable, `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, paidKey: Boolean(process.env.OPENAI_API_KEY), unrelated: process.env.PRIVATE_TEST_VALUE})+'\\n');
const scenario = ${JSON.stringify(scenario)};
if (args[0] === '--version') console.log('codex-cli 0.159.0');
else if (args.join(' ') === 'login status') { console.log(scenario === 'api-auth' ? 'Logged in using an API key' : 'Logged in using ChatGPT'); }
else if (args.join(' ') === 'cloud --help') console.log('Commands:\\n  exec    Submit a task\\n  status  Show status\\n  list    List tasks\\n  diff    Show diff');
else if (args.includes('--help')) { console.log(args[1] === 'exec' ? 'Usage: codex cloud exec --env <ENV_ID> [QUERY]' : 'unsupported subcommand'); if (['resume','cancel'].includes(args[1])) process.exitCode = 2; }
else if (args[1] === 'list') console.log(scenario === 'malformed' ? '{bad json' : '{"tasks":[],"cursor":null}');
else if (args[1] === 'exec') {
  if (scenario === 'hang') setInterval(() => {}, 1000);
  else if (!args.includes('--env')) { console.error('error: required --env <ENV_ID>'); process.exitCode = 2; }
  else if (scenario === 'ambiguous') { console.error('connection lost after submission'); process.exitCode = 1; }
  else console.log('https://chatgpt.com/codex/tasks/task_synthetic123');
} else if (args[1] === 'status') console.log(scenario === 'not-ready' ? '[RUNNING] synthetic task' : '[READY] synthetic task');
else if (args[1] === 'diff') console.log(scenario === 'wrong-result' ? 'diff --git a/qualification-result.json b/qualification-result.json\\n+{"sum":41}': scenario === 'unrelated-result' ? 'diff --git a/qualification-result.json b/qualification-result.json\\n+{"sum":41}\\ndiff --git a/other.json b/other.json\\n+{"sum":42}' : 'diff --git a/qualification-result.json b/qualification-result.json\\n+{"sum":42}');
else process.exitCode = 2;
`)
  return { dir, calls, options: { stateFile: join(dir, 'receipt.json'), codexCommand: [process.execPath, executable],
    sourceRevision: 'a'.repeat(40), model: 'gpt-6.1-sol', effort: 'low', cwd: dir, timeoutMs: 5000 },
    environment: { id: 'env-synthetic', repository: 'jbookout/software-factory', branch: 'main', factoryOnly: true } }
}

test('live CLI probes retain blocked missing-environment results without fabricating task/model/usage', async () => {
  const f = await fixture()
  const receipt = await qualifyCodexCloud(f.options)
  assert.equal(receipt.qualified, false)
  assert.equal(receipt.taskId, null)
  assert.equal(receipt.checks.submission.status, 'blocked')
  assert.match(receipt.checks.submission.reason, /environment/)
  assert.equal(receipt.checks.resume.status, 'unsupported')
  assert.equal(receipt.checks.cancel.status, 'unsupported')
  for (const check of ['actualModel', 'actualEffort', 'usage', 'laptopIndependent', 'expiryRecovery']) {
    assert.notEqual(receipt.checks[check].status, 'passed')
  }
  const stored = JSON.parse(await readFile(f.options.stateFile))
  assert.deepEqual(stored, receipt)
  assert.equal((await stat(f.options.stateFile)).mode & 0o777, 0o600)
})

test('selected factory environment submits once and reads a result without qualifying unsupported lifecycle/account facts', async () => {
  const f = await fixture('success')
  const options = { ...f.options, environment: f.environment }
  const receipt = await qualifyCodexCloud(options)
  assert.equal(receipt.taskId, 'task_synthetic123')
  assert.equal(receipt.checks.submission.status, 'passed')
  assert.equal(receipt.checks.result.status, 'passed')
  assert.equal(receipt.resultArtifact.digest, `sha256:${createHash('sha256').update(receipt.resultArtifact.bytes).digest('hex')}`)
  assert.equal(receipt.qualified, false)
  assert.equal(receipt.dependentRoutes['claude-subscription'].status, 'blocked')
  const again = await qualifyCodexCloud(options)
  assert.deepEqual(again, receipt)
  const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(calls.filter(c => c.args[1] === 'exec' && !c.args.includes('--help')).length, 1)
  assert.equal(calls.some(c => c.args[0] === 'exec' || c.args.includes('apply')), false)
  const submission = calls.find(c => c.args[1] === 'exec' && !c.args.includes('--help'))
  assert.equal(submission.args[submission.args.indexOf('--env') + 1], 'env-synthetic')
  assert.ok(submission.args.includes('model="gpt-6.1-sol"'))
  assert.ok(submission.args.includes('model_reasoning_effort="low"'))
})

test('paid API credentials and unrelated secrets are never forwarded; API-key login refuses submission', async () => {
  const prior = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'synthetic-paid-key'
  process.env.PRIVATE_TEST_VALUE = 'synthetic-private-value'
  try {
    const f = await fixture('api-auth')
    const receipt = await qualifyCodexCloud({ ...f.options, environment: f.environment })
    assert.equal(receipt.checks.submission.status, 'blocked')
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.some(c => c.paidKey || c.unrelated), false)
    assert.equal(calls.some(c => c.args[1] === 'exec' && !c.args.includes('--help')), false)
  } finally {
    if (prior === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prior
    delete process.env.PRIVATE_TEST_VALUE
  }
})

for (const scenario of ['ambiguous', 'hang']) {
  test(`${scenario} submission retains unknown outcome and restart never resubmits or claims remote cancellation`, async () => {
    const f = await fixture(scenario)
    const options = { ...f.options, environment: f.environment, timeoutMs: scenario === 'hang' ? 2000 : 5000 }
    const receipt = await qualifyCodexCloud(options)
    assert.equal(receipt.phase, 'submission-pending')
    assert.equal(receipt.taskId, null)
    assert.equal(receipt.qualified, false)
    assert.equal(receipt.checks.remoteTimeout.status, 'unverified')
    if (scenario === 'hang') assert.equal(receipt.probes.find(p => p.name === 'submission').timedOut, true)
    await qualifyCodexCloud(options)
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.filter(c => c.args[1] === 'exec' && !c.args.includes('--help')).length, 1)
  })
}

for (const scenario of ['wrong-result', 'unrelated-result', 'not-ready']) {
  test(`${scenario} cannot pass the synthetic artifact comparison`, async () => {
    const f = await fixture(scenario)
    const options = { ...f.options, environment: f.environment }
    const receipt = await qualifyCodexCloud(options)
    assert.equal(receipt.checks.result.status, 'blocked')
    const again = await qualifyCodexCloud(options)
    assert.equal(again.taskId, receipt.taskId)
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.filter(c => c.args[1] === 'exec' && !c.args.includes('--help')).length, 1)
  })
}

test('recovery checks subscription authentication before reading the existing cloud task', async () => {
  const f = await fixture('not-ready')
  const options = { ...f.options, environment: f.environment }
  const receipt = await qualifyCodexCloud(options)
  assert.equal(receipt.phase, 'submitted')
  const executable = f.options.codexCommand[1]
  const source = await readFile(executable, 'utf8')
  await writeFile(executable, source.replace('const scenario = "not-ready"', 'const scenario = "api-auth"'))
  const before = (await readFile(f.calls, 'utf8')).trim().split('\n').length
  const recovered = await qualifyCodexCloud(options)
  assert.equal(recovered.taskId, receipt.taskId)
  assert.equal(recovered.checks.result.status, 'blocked')
  const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').slice(before).map(JSON.parse)
  assert.equal(calls.some(c => c.args[0] === 'cloud' && ['status', 'diff'].includes(c.args[1])), false)
})

test('malformed task list fails closed; changed request, competing run and forged qualification are rejected', async () => {
  const f = await fixture('malformed')
  const receipt = await qualifyCodexCloud(f.options)
  assert.equal(receipt.checks.submission.status, 'blocked')
  assert.match(receipt.checks.submission.reason, /task-list/)
  await assert.rejects(qualifyCodexCloud({ ...f.options, model: 'different-model' }), /request changed/)
  await writeFile(`${f.options.stateFile}.lock`, '')
  await assert.rejects(qualifyCodexCloud(f.options), { code: 'EEXIST' })
  const other = await fixture()
  const stored = await qualifyCodexCloud(other.options)
  stored.qualified = true
  await writeFile(other.options.stateFile, JSON.stringify(stored))
  await assert.rejects(qualifyCodexCloud(other.options), /stored receipt/)
})

test('invalid environment and unbounded deadline refuse before any process starts', async () => {
  const f = await fixture()
  await assert.rejects(qualifyCodexCloud({ ...f.options, environment: { ...f.environment, repository: 'other/product' } }), /factory-only/)
  await assert.rejects(qualifyCodexCloud({ ...f.options, timeoutMs: 0 }), /bounded/)
  await assert.rejects(readFile(f.calls), { code: 'ENOENT' })
})
