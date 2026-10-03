import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat, mkdir, symlink, chmod, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { qualifyCodexCloud } from 'software-factory/codex-cloud-qualification'

// A real subprocess at the CLI seam; no network, account or model calls.
const newFileDiff = (body = '{"sum":42}', newline = true, mode = '100644') => [
  'diff --git a/qualification-result.json b/qualification-result.json',
  `new file mode ${mode}`, 'index 0000000..abc1234', '--- /dev/null',
  '+++ b/qualification-result.json', `@@ -0,0 +1,${body.split('\n').length} @@`,
  ...body.split('\n').map(line => `+${line}`),
  ...(!newline ? ['\\ No newline at end of file'] : [])
].join('\n') + '\n'

async function fixture(scenario = 'no-environment', outputs = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-cloud-qualification-'))
  const executable = join(dir, 'fake-codex.mjs')
  const calls = join(dir, 'calls.jsonl')
  await writeFile(executable, `
import { appendFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, paidKey: Boolean(process.env.OPENAI_API_KEY), unrelated: process.env.PRIVATE_TEST_VALUE})+'\\n');
const scenario = ${JSON.stringify(scenario)};
const outputs = ${JSON.stringify(outputs)};
if (args[0] === '--version') console.log(outputs.version ?? 'codex-cli 0.159.0');
else if (args.join(' ') === 'login status') {
  if (scenario === 'replace-receipt') { renameSync(${JSON.stringify(join(dir, 'receipt.json'))}, ${JSON.stringify(join(dir, 'original-receipt.json'))}); writeFileSync(${JSON.stringify(join(dir, 'receipt.json'))}, 'synthetic sentinel', {mode:0o600}); }
  if (scenario === 'relaxed-directory') chmodSync(${JSON.stringify(dir)}, 0o755);
  console.log(scenario === 'api-auth' ? 'Logged in using an API key' : 'Logged in using ChatGPT'); }
else if (args.join(' ') === 'cloud --help') console.log(outputs.help ?? 'Commands:\\n  exec    Submit a task\\n  status  Show status\\n  list    List tasks\\n  diff    Show diff');
else if (args.includes('--help')) { console.log(args[1] === 'exec' ? 'Usage: codex cloud exec --env <ENV_ID> [QUERY]' : 'unsupported subcommand'); if (['resume','cancel'].includes(args[1])) process.exitCode = 2; }
else if (args[1] === 'list') console.log(scenario === 'malformed' ? '{bad json' : '{"tasks":[],"cursor":null}');
else if (args[1] === 'exec') {
  if (scenario === 'hang') setInterval(() => {}, 1000);
  else if (!args.includes('--env')) { console.error('error: required --env <ENV_ID>'); process.exitCode = 2; }
  else if (scenario === 'ambiguous') { console.error('connection lost after submission'); process.exitCode = 1; }
  else console.log('https://chatgpt.com/codex/tasks/task_synthetic123');
} else if (args[1] === 'status') console.log(outputs.status ?? (scenario === 'not-ready' ? '[RUNNING] synthetic task' : '[READY] synthetic task'));
else if (args[1] === 'diff') process.stdout.write(outputs.diff ?? ${JSON.stringify(newFileDiff(scenario === 'wrong-result' || scenario === 'unrelated-result' ? '{"sum":41}' : '{"sum":42}'))});
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
  assert.equal(receipt.resultArtifact.bytes, '{"sum":42}\n')
  assert.equal(receipt.resultArtifact.digest, `sha256:${createHash('sha256').update('{"sum":42}\n').digest('hex')}`)
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

// Blocking review regressions cross the exported execution/CLI interfaces.
const settingsBinding = () => ({ userId: 'synthetic-user', workerId: 'synthetic-worker',
  version: 1, settingsDigest: `sha256:${'b'.repeat(64)}`, station: 'define', mode: 'fast' })

for (const [name, diff] of Object.entries({
  'context retained in modified file': 'diff --git a/qualification-result.json b/qualification-result.json\nindex abc1234..def1234 100644\n--- a/qualification-result.json\n+++ b/qualification-result.json\n@@ -1,2 +1,2 @@\n-{"sum":41}\n+{"sum":42}\n {"extra":1}\n',
  'symlink artifact': newFileDiff('{"sum":42}', false, '120000'),
  'missing headers': 'diff --git a/qualification-result.json b/qualification-result.json\n+{"sum":42}\n',
  'wrong hunk count': newFileDiff().replace('+1,1', '+1,2'),
  'another modified file': newFileDiff() + 'diff --git a/other.json b/other.json\n+{"sum":42}\n',
  'duplicate artifact': newFileDiff() + newFileDiff(),
  'unrecognized trailing output': newFileDiff() + 'unexpected output\n'
})) {
  test(`finding 1: ${name} cannot certify a regular JSON file`, async () => {
    const f = await fixture('success', { diff })
    const receipt = await qualifyCodexCloud({ ...f.options, environment: f.environment })
    assert.equal(receipt.checks.result.status, 'blocked')
    assert.equal(receipt.resultArtifact, null)
    assert.equal(receipt.phase, 'submitted')
  })
}
for (const newline of [true, false]) {
  test(`finding 1: independent file bytes preserve final newline=${newline}`, async () => {
    const f = await fixture('success', { diff: newFileDiff('{\n  "sum":42\n}', newline) })
    const receipt = await qualifyCodexCloud({ ...f.options, environment: f.environment })
    const expected = '{\n  "sum":42\n}' + (newline ? '\n' : '')
    assert.equal(receipt.resultArtifact.bytes, expected)
    assert.equal(receipt.resultArtifact.digest, `sha256:${createHash('sha256').update(expected).digest('hex')}`)
    assert.equal(receipt.checks.result.status, 'passed')
  })
}
for (const status of ['[PENDING] synthetic title mentioning [READY]', '[ERROR] title [READY]',
  '[READY] title\n[PENDING] other status', 'metadata [READY] title']) {
  test(`finding 2: only an unambiguous leading READY status can finish (${status})`, async () => {
    const f = await fixture('success', { status })
    const options = { ...f.options, environment: f.environment }
    const receipt = await qualifyCodexCloud(options)
    assert.equal(receipt.phase, 'submitted')
    const before = (await readFile(f.calls, 'utf8')).split('\n').length
    await qualifyCodexCloud(options)
    const later = (await readFile(f.calls, 'utf8')).split('\n').slice(before - 1).filter(Boolean).map(JSON.parse)
    assert.ok(later.some(c => c.args[1] === 'status'))
  })
}

test('finding 3: caller mutations cannot alter validated request, arguments or digest', async () => {
  const f = await fixture('success')
  const options = { ...f.options, environment: { ...f.environment }, settingsBinding: settingsBinding() }
  const expected = structuredClone({ environment: options.environment, settingsBinding: options.settingsBinding })
  const pending = qualifyCodexCloud(options)
  options.environment.factoryOnly = false
  options.environment.repository = 'other/product'
  options.environment.branch = 'changed-branch'
  options.settingsBinding.mode = 'changed-mode'
  options.codexCommand[0] = 'nonexistent-command'
  const receipt = await pending
  assert.deepEqual(receipt.request.environment, expected.environment)
  assert.deepEqual(receipt.request.settingsBinding, expected.settingsBinding)
  assert.ok(Object.isFrozen(receipt.request.environment))
  assert.ok(Object.isFrozen(receipt.request.settingsBinding))
  assert.equal(receipt.requestDigest, `sha256:${createHash('sha256').update(JSON.stringify(receipt.request)).digest('hex')}`)
  const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse)
  const submit = calls.find(c => c.args[1] === 'exec' && !c.args.includes('--help'))
  assert.equal(submit.args[submit.args.indexOf('--branch') + 1], 'main')
  options.settingsBinding.version = 7
  assert.equal(receipt.request.settingsBinding.version, 1)
})

test('finding 4: predictable temporary symlink never changes the unrelated sentinel', async () => {
  const f = await fixture('api-auth')
  const sentinel = join(f.dir, 'sentinel')
  await writeFile(sentinel, 'keep these bytes', { mode: 0o640 })
  await symlink(sentinel, `${f.options.stateFile}.tmp`)
  await qualifyCodexCloud(f.options)
  assert.equal(await readFile(sentinel, 'utf8'), 'keep these bytes')
  assert.equal((await stat(sentinel)).mode & 0o777, 0o640)
  assert.ok((await lstat(`${f.options.stateFile}.tmp`)).isSymbolicLink())
})
test('finding 4: receipt symlinks and nonprivate directories are refused before probes', async () => {
  const f = await fixture('api-auth')
  const sentinel = join(f.dir, 'sentinel')
  await writeFile(sentinel, 'keep')
  await symlink(sentinel, f.options.stateFile)
  await assert.rejects(qualifyCodexCloud(f.options), /regular|symlink/)
  assert.equal(await readFile(sentinel, 'utf8'), 'keep')
  const other = await fixture('api-auth')
  await chmod(other.dir, 0o755)
  await assert.rejects(qualifyCodexCloud(other.options), /private/)
  await assert.rejects(readFile(other.calls), { code: 'ENOENT' })
})

test('finding 5: direct and canonicalized checkout paths refuse before lock or receipt creation', async () => {
  const f = await fixture('api-auth')
  const checkout = join(f.dir, 'checkout')
  await mkdir(join(checkout, '.git'), { recursive: true })
  const alias = join(f.dir, 'alias')
  await symlink(checkout, alias)
  for (const stateFile of [join(checkout, 'private', 'receipt.json'), join(alias, 'private', 'receipt.json'),
    resolve('private-qualification-receipt.json')]) {
    await assert.rejects(qualifyCodexCloud({ ...f.options, stateFile }), /outside.*checkout/)
    await assert.rejects(stat(`${stateFile}.lock`), { code: 'ENOENT' })
    await assert.rejects(stat(stateFile), { code: 'ENOENT' })
  }
  await assert.rejects(readFile(f.calls), { code: 'ENOENT' })
})

test('finding 6: all receipt derivatives omit diagnostic canaries', async () => {
  const canary = 'synthetic-' + 'credential-canary'
  const f = await fixture('success', { version: `codex-cli 0.159.0\nBearer ${canary}`,
    help: JSON.stringify({ password: canary, access_token: canary, nested: { authorization: canary } }) })
  const receipt = await qualifyCodexCloud({ ...f.options, environment: f.environment })
  assert.equal(JSON.stringify(receipt).includes(canary), false)
  assert.equal((await readFile(f.options.stateFile, 'utf8')).includes(canary), false)
  assert.equal(receipt.cliVersion, undefined)
  assert.equal(receipt.checks.submission.status, 'blocked')
  const json = await fixture('success', { help: JSON.stringify({ password: canary, access_token: canary }) })
  const safe = await qualifyCodexCloud({ ...json.options, environment: json.environment })
  assert.equal(safe.cliVersion, 'codex-cli 0.159.0')
  assert.equal(JSON.stringify(safe).includes(canary), false)
})

for (const [name, change] of Object.entries({
  '41-character revision': options => { options.sourceRevision = 'a'.repeat(41) },
  '63-character revision': options => { options.sourceRevision = 'a'.repeat(63) },
  'non-string branch': options => { options.environment.branch = 123 },
  'non-string digest': options => { options.settingsBinding.settingsDigest = { toString: () => `sha256:${'b'.repeat(64)}` } },
  'inherited binding fields': options => { options.settingsBinding = Object.create(options.settingsBinding) },
  'missing station': options => { delete options.settingsBinding.station },
  'missing mode': options => { delete options.settingsBinding.mode },
  'unknown station': options => { options.settingsBinding.station = 'other' },
  'unknown mode': options => { options.settingsBinding.mode = 'other' },
  'binding credential extra': options => { options.settingsBinding.password = 'synthetic-canary' },
  'environment credential extra': options => { options.environment.access_token = 'synthetic-canary' },
  'request credential extra': options => { options.password = 'synthetic-canary' }
})) {
  test(`finding 7: ${name} is rejected before persistence`, async () => {
    const f = await fixture('api-auth')
    const options = { ...f.options, environment: { ...f.environment }, settingsBinding: settingsBinding() }
    change(options)
    await assert.rejects(qualifyCodexCloud(options), /sourceRevision|binding|unknown.*field|environment/)
    await assert.rejects(stat(options.stateFile), { code: 'ENOENT' })
    await assert.rejects(readFile(f.calls), { code: 'ENOENT' })
  })
}

test('finding 8: absolute-path CLI binds the executing factory revision from another repository', async () => {
  const f = await fixture('api-auth')
  const invoking = join(f.dir, 'other-repository')
  await mkdir(invoking)
  execFileSync('git', ['init', '-q', invoking])
  await writeFile(join(invoking, 'synthetic.txt'), 'synthetic fixture')
  execFileSync('git', ['-C', invoking, 'add', 'synthetic.txt'])
  execFileSync('git', ['-C', invoking, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic',
    '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'synthetic fixture'])
  const factory = fileURLToPath(new URL('../../', import.meta.url))
  const sourceRevision = execFileSync('git', ['-C', factory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const codex = join(f.dir, 'codex')
  await writeFile(codex, `#!${process.execPath}\n${await readFile(f.options.codexCommand[1], 'utf8')}`)
  await chmod(codex, 0o700)
  await assert.rejects(promisify(execFile)(process.execPath, [join(factory, 'bin/design-cloud-qualify.mjs'),
    '--settings', join(factory, 'config/design-manager/joe.example.json'), '--state', f.options.stateFile],
  { cwd: invoking, env: { ...process.env, PATH: `${f.dir}:${process.env.PATH}` } }), { code: 2 })
  const receipt = JSON.parse(await readFile(f.options.stateFile, 'utf8'))
  assert.equal(receipt.request.sourceRevision, sourceRevision)
})

test('finding 6: legacy receipts with raw observations are refused without replay', async () => {
  const f = await fixture('api-auth')
  const receipt = await qualifyCodexCloud(f.options)
  receipt.schema = 'codex-cloud-qualification.v1'
  receipt.cliVersion = 'Bearer synthetic-legacy-canary'
  const { receiptDigest, ...content } = receipt
  receipt.receiptDigest = `sha256:${createHash('sha256').update(JSON.stringify(content)).digest('hex')}`
  await writeFile(f.options.stateFile, JSON.stringify(receipt))
  const before = await readFile(f.calls, 'utf8')
  await assert.rejects(qualifyCodexCloud(f.options), /receipt|request changed/)
  assert.equal(await readFile(f.calls, 'utf8'), before)
})


test('finding 4: receipt substitution during a probe preserves the replacement sentinel', async () => {
  const f = await fixture('replace-receipt')
  await assert.rejects(qualifyCodexCloud(f.options), /receipt.*changed/)
  assert.equal(await readFile(f.options.stateFile, 'utf8'), 'synthetic sentinel')
  const original = JSON.parse(await readFile(join(f.dir, 'original-receipt.json'), 'utf8'))
  assert.equal(original.phase, 'preflight')
})
test('finding 4: a directory losing its private permissions stops further writes', async () => {
  const f = await fixture('relaxed-directory')
  await assert.rejects(qualifyCodexCloud(f.options), /private.*directory.*changed/)
  const original = JSON.parse(await readFile(f.options.stateFile, 'utf8'))
  assert.equal(original.probes.length, 0)
})


test('finding 6: CLI printed summary and stored receipt exclude diagnostic canaries', async () => {
  const canary = 'synthetic-' + 'cli-canary'
  const f = await fixture('success', { version: `codex-cli 0.159.0\nBearer ${canary}`,
    help: JSON.stringify({ password: canary, access_token: canary }) })
  const factory = fileURLToPath(new URL('../../', import.meta.url))
  const codex = join(f.dir, 'codex')
  await writeFile(codex, `#!${process.execPath}\n${await readFile(f.options.codexCommand[1], 'utf8')}`)
  await chmod(codex, 0o700)
  await assert.rejects(promisify(execFile)(process.execPath, [join(factory, 'bin/design-cloud-qualify.mjs'),
    '--settings', join(factory, 'config/design-manager/joe.example.json'), '--state', f.options.stateFile],
  { cwd: f.dir, env: { ...process.env, PATH: `${f.dir}:${process.env.PATH}` } }), error => {
    assert.equal(error.code, 2)
    assert.equal(error.stdout.includes(canary), false)
    assert.equal(error.stderr.includes(canary), false)
    assert.equal(JSON.parse(error.stdout).cliVersion, undefined)
    return true
  })
  assert.equal((await readFile(f.options.stateFile, 'utf8')).includes(canary), false)
})
