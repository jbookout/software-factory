import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, lstat, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { runProcess } from './process-runner.mjs'
import { DESIGN_STATIONS, MODEL_MODES } from './design-manager.mjs'
import { deepFreeze } from './canonical.mjs'

export const CLOUD_SAMPLE_PROMPT = 'Synthetic factory runtime qualification only. Do not use subagents, credentials, external services, product data, commits, PRs or deployment. In this disposable workspace compute 19 + 23 and write qualification-result.json containing exactly {"sum":42}. Read it back and verify sum is 42. Report the result. Do not modify other files.'
const check = (status, reason) => ({ status, reason })
const unknown = reason => check('unverified', reason)
const hashBytes = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const digest = value => hashBytes(JSON.stringify(value))
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino
const privateOwner = info => process.getuid === undefined || info.uid === process.getuid()
async function maybeStat(file) {
  try { return await lstat(file) } catch (error) { if (error.code !== 'ENOENT') throw error; return null }
}

// Check the canonical destination before creating anything. This covers .git
// directories and worktree .git files, including symlinked parent directories.
async function privateReceiptPath(file) {
  let ancestor = dirname(resolve(file))
  const missing = []
  while (!await maybeStat(ancestor)) { missing.unshift(basename(ancestor)); ancestor = dirname(ancestor) }
  ancestor = await realpath(ancestor)
  const parent = join(ancestor, ...missing)
  for (let path = parent; ; path = dirname(path)) {
    if (await maybeStat(join(path, '.git'))) throw new Error('private receipt must be outside every Git checkout')
    if (dirname(path) === path) break
  }
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const identity = await lstat(parent)
  if (!identity.isDirectory() || !privateOwner(identity) || (identity.mode & 0o777) !== 0o700) {
    throw new Error('receipt directory must be private, owned by this user and mode 700')
  }
  const verify = async () => {
    const info = await lstat(parent)
    if (!sameFile(identity, info) || !privateOwner(info) || (info.mode & 0o777) !== 0o700 ||
        await realpath(parent) !== parent) {
      throw new Error('private receipt directory changed')
    }
  }
  const path = join(parent, basename(file))
  let currentIdentity = await maybeStat(path)
  const verifyFile = async () => {
    await verify()
    const info = await maybeStat(path)
    if ((info || currentIdentity) && (!info || !currentIdentity || !sameFile(info, currentIdentity))) {
      throw new Error('receipt path changed during qualification')
    }
    if (info && (!info.isFile() || info.nlink !== 1 || !privateOwner(info) || (info.mode & 0o777) !== 0o600)) {
      throw new Error('receipt must be a private regular file, never a symlink or hard link')
    }
    return info
  }
  await verifyFile()
  return { path, verify, verifyFile, replaced: identity => { currentIdentity = identity } }
}

async function persist(storage, value) {
  const { receiptDigest: ignored, ...content } = value
  value.receiptDigest = digest(content)
  await storage.verifyFile()
  const temp = join(dirname(storage.path), `.receipt-${randomUUID()}.tmp`)
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const identity = await handle.stat()
  let owned = true
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
    await storage.verifyFile()
    if (!sameFile(identity, await lstat(temp))) throw new Error('temporary receipt changed')
    await rename(temp, storage.path)
    storage.replaced(identity)
    owned = false
  } finally {
    await handle.close()
    // Never remove a pre-existing or substituted temporary path.
    if (owned) {
      await storage.verify()
      const info = await maybeStat(temp)
      if (info && sameFile(identity, info)) await unlink(temp)
    }
  }
}

function sampleResult(diff) {
  const lines = diff.split('\n')
  if (lines.pop() !== '' || lines.shift() !== 'diff --git a/qualification-result.json b/qualification-result.json' ||
      !/^new file mode 100(?:644|755)$/.test(lines.shift() ?? '')) return null
  if (/^index 0{7,64}\.\.[a-f0-9]{7,64}$/.test(lines[0] ?? '')) lines.shift()
  if (lines.shift() !== '--- /dev/null' || lines.shift() !== '+++ b/qualification-result.json') return null
  const hunk = /^@@ -0,0 \+1(?:,(\d+))? @@$/.exec(lines.shift() ?? '')
  if (!hunk) return null
  let newline = true
  if (lines.at(-1) === '\\ No newline at end of file') { lines.pop(); newline = false }
  if (lines.length !== Number(hunk[1] ?? 1) || !lines.length || lines.some(line => !line.startsWith('+'))) return null
  const bytes = lines.map(line => line.slice(1)).join('\n') + (newline ? '\n' : '')
  try {
    const value = JSON.parse(bytes)
    return value.sum === 42 && Object.keys(value).length === 1 ? { bytes, digest: hashBytes(bytes) } : null
  } catch { return null }
}

function exactFields(value, fields, name, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) throw new Error(`unknown ${name} field or missing required field`)
}
function requestFor({ sourceRevision, model, effort, environment = null, settingsBinding = null }) {
  if (typeof sourceRevision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceRevision)) throw new Error('exact sourceRevision required')
  if (!validId(model) || !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('invalid model or effort')
  const environmentFields = ['id', 'factoryOnly', 'repository', 'branch']
  if (environment !== null) exactFields(environment, environmentFields, 'environment', environmentFields)
  if (environment !== null && (!validId(environment.id) || environment.factoryOnly !== true ||
      environment.repository !== 'jbookout/software-factory' || typeof environment.branch !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9/._-]{0,199}$/.test(environment.branch))) {
    throw new Error('an explicitly selected factory-only environment and branch are required')
  }
  const bindingFields = ['userId', 'workerId', 'version', 'settingsDigest', 'station', 'mode']
  if (settingsBinding !== null) exactFields(settingsBinding, bindingFields, 'settings binding', bindingFields)
  if (settingsBinding !== null && (!validId(settingsBinding.userId) || !validId(settingsBinding.workerId) ||
      !Number.isInteger(settingsBinding.version) || settingsBinding.version < 1 ||
      !DESIGN_STATIONS.includes(settingsBinding.station) || !MODEL_MODES.includes(settingsBinding.mode) ||
      typeof settingsBinding.settingsDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(settingsBinding.settingsDigest))) throw new Error('invalid settings binding')
  return deepFreeze({ sourceRevision, model, effort, environment: environment && { ...environment },
    settingsBinding: settingsBinding && { ...settingsBinding }, sampleDigest: hashBytes(CLOUD_SAMPLE_PROMPT) })
}

function readyStatus(output) {
  const lines = output.trim().split('\n')
  return /^\[READY\](?:[ \t]|$)/.test(lines[0]) &&
    !lines.slice(1).some(line => /^\s*\[[A-Z_]+\]/.test(line))
}
const versionValue = output => /^codex-cli \d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(output.trim()) ? output.trim() : undefined

// Qualification is intentionally fail-closed for this CLI surface. Observation is
// not certification: local deadlines never prove remote cancellation/timeout,
// local config never proves the cloud's model, and login never proves entitlement.
export async function qualifyCodexCloud(options) {
  exactFields(options, ['stateFile', 'codexCommand', 'cwd', 'timeoutMs', 'sourceRevision', 'model', 'effort', 'environment', 'settingsBinding'], 'request')
  const { stateFile, cwd, timeoutMs = 30_000 } = options
  const codexCommand = [...(options.codexCommand ?? ['codex'])]
  if (typeof stateFile !== 'string' || !stateFile || !Array.isArray(options.codexCommand ?? []) || !codexCommand.length ||
      (cwd !== undefined && (typeof cwd !== 'string' || !cwd)) ||
      codexCommand.some(s => typeof s !== 'string' || !s) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('stateFile, command and bounded timeoutMs required')
  }
  const request = requestFor(options)
  const storage = await privateReceiptPath(stateFile)
  await storage.verify()
  const lockPath = `${storage.path}.lock`
  const lock = await open(lockPath, 'wx', 0o600)
  const lockIdentity = await lock.stat()
  const save = () => persist(storage, receipt)
  let receipt
  try {
    const previous = await storage.verifyFile()
    if (previous) {
      const handle = await open(storage.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if (!sameFile(previous, await handle.stat())) throw new Error('stored receipt changed')
        receipt = JSON.parse(await handle.readFile('utf8'))
      } finally { await handle.close() }
    }
    if (receipt) {
      if (receipt.schema !== 'codex-cloud-qualification.v2' || receipt.requestDigest !== digest(request)) throw new Error('qualification request changed or legacy receipt; inspect existing cloud tasks before using a new private receipt')
      const { receiptDigest, ...content } = receipt
      if (receipt.qualified !== false || receiptDigest !== digest(content) || digest(receipt.request) !== digest(request) ||
          !['preflight', 'submission-pending', 'submitted', 'finished'].includes(receipt.phase)) throw new Error('invalid stored receipt; verify the original observations before recovery')
      // An interrupted submission may have reached the cloud. Never retry it.
      if (receipt.phase === 'submission-pending' && !receipt.taskId) {
        receipt.checks.submission = check('blocked', 'submission outcome unknown: inspect cloud tasks before any new attempt')
        await save()
      }
      receipt.request = request
      if (!receipt.taskId || receipt.phase === 'finished') return receipt
    } else {
      receipt = { schema: 'codex-cloud-qualification.v2', request, requestDigest: digest(request),
        startedAt: new Date().toISOString(), phase: 'preflight', taskId: null, qualified: false, probes: [],
        checks: Object.fromEntries(['submission', 'result', 'actualModel', 'actualEffort', 'usage', 'resume', 'cancel',
          'remoteTimeout', 'laptopIndependent', 'entitlement', 'expiryRecovery'].map(name => [name, unknown('not observed on this account and cloud task')])),
        dependentRoutes: {
          'claude-subscription': check('blocked', 'Claude execution prohibited for this build; persistent-host subscription judgment and expiry/limits remain unqualified'),
          'dot-chatgpt': check('blocked', 'programmatic research/import route and account entitlement unqualified'),
          'grok-research': check('blocked', 'research/import route unqualified by this harness')
        } }
      await save()
    }
    // Do not inherit paid API credentials or unrelated process secrets.
    const env = Object.fromEntries(['HOME', 'PATH', 'CODEX_HOME', 'TMPDIR', 'SystemRoot', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
    const probe = async (name, args, projection = () => 'raw diagnostics omitted') => {
      const start = Date.now()
      let result
      try { result = await runProcess([...codexCommand, ...args], { cwd, env, timeoutMs, maxOutputBytes: 64_000 }) }
      catch (error) { result = { code: 1, timedOut: false, overflow: false, stdout: '', stderr: `process unavailable: ${error.code ?? 'unknown'}` } }
      const output = `${result.stdout}\n${result.stderr}`.trim()
      receipt.probes.push({ name, args, code: result.code, timedOut: result.timedOut, overflow: result.overflow,
        durationMs: Date.now() - start, observedAt: new Date().toISOString(), output: projection(output) })
      await save()
      return { ...result, output }
    }
    const login = await probe('authentication', ['login', 'status'], output =>
      /Logged in using ChatGPT/.test(output) ? 'Logged in using ChatGPT' : 'subscription login not confirmed')
    if (login.code !== 0 || !/Logged in using ChatGPT/.test(login.output)) {
      receipt.checks[receipt.taskId ? 'result' : 'submission'] = check('blocked', 'ChatGPT authentication failed; no API fallback')
      if (!receipt.taskId) receipt.phase = 'finished'
      await save()
      return receipt
    }
    if (!receipt.taskId) {
      const version = await probe('version', ['--version'])
      receipt.cliVersion = versionValue(version.stdout)
      const help = await probe('cloud-help', ['cloud', '--help'])
      await probe('submit-help', ['cloud', 'exec', '--help'])
      for (const name of ['resume', 'cancel']) {
        const result = await probe(`${name}-help`, ['cloud', name, '--help'])
        receipt.checks[name] = result.code === 0
          ? unknown('CLI advertises a route but its lifecycle is not qualified by this adapter')
          : check('unsupported', `installed CLI rejects cloud ${name}; no local-session substitute`)
      }
      receipt.checks.actualModel = unknown('requested local config is not an actual cloud model readback')
      receipt.checks.actualEffort = unknown('requested local config is not an actual cloud effort readback')
      receipt.checks.usage = unknown('no documented cloud CLI usage/allowance readback qualified')
      receipt.checks.remoteTimeout = unknown('local subprocess deadline does not terminate a remote task')
      if (help.code !== 0 || version.code !== 0 || !receipt.cliVersion) {
        receipt.checks.submission = check('blocked', 'ChatGPT authentication or CLI preflight failed; no API fallback')
        receipt.phase = 'finished'
        await save()
        return receipt
      }
      const list = await probe('task-list', ['cloud', 'list', '--json', '--limit', '1'], output => {
        try { const data = JSON.parse(output); return JSON.stringify({ taskCount: Array.isArray(data.tasks) ? data.tasks.length : null }) }
        catch { return 'invalid task-list JSON (raw task details omitted)' }
      })
      try {
        if (list.code !== 0 || !Array.isArray(JSON.parse(list.stdout).tasks)) throw new Error()
      } catch {
        receipt.checks.submission = check('blocked', 'task-list readback failed; no blind submission')
        receipt.phase = 'finished'
        await save()
        return receipt
      }
      const args = ['cloud', 'exec', '--attempts', '1',
        '-c', `model=${JSON.stringify(request.model)}`, '-c', `model_reasoning_effort=${JSON.stringify(request.effort)}`]
      if (request.environment) args.push('--env', request.environment.id, '--branch', request.environment.branch)
      args.push(CLOUD_SAMPLE_PROMPT)
      // Persist before the external call, including for a timeout/lost response.
      receipt.phase = 'submission-pending'
      await save()
      const submit = await probe('submission', args)
      receipt.taskId = submit.stdout.match(/https:\/\/chatgpt\.com\/codex\/tasks\/(task_[A-Za-z0-9_-]+)/)?.[1] ?? null
      if (!receipt.taskId) {
        receipt.checks.submission = check('blocked', request.environment
          ? 'submission outcome unknown: inspect cloud tasks before retry; no task ID was read back'
          : 'factory-only environment missing; CLI submission refused without --env')
        // No selected environment means the CLI cannot submit. With an environment
        // an ambiguous call stays pending so a later invocation never resubmits.
        receipt.phase = request.environment ? 'submission-pending' : 'finished'
        await save()
        return receipt
      }
      receipt.checks.submission = check('passed', 'cloud task ID read from CLI response; entitlement/usage still unverified')
      receipt.phase = 'submitted'
      await save()
    }
    if (!/^task_[A-Za-z0-9_-]+$/.test(receipt.taskId)) throw new Error('invalid stored cloud task ID')
    const status = await probe('task-status', ['cloud', 'status', receipt.taskId])
    const diff = await probe('task-diff', ['cloud', 'diff', receipt.taskId])
    const result = sampleResult(diff.stdout)
    receipt.resultArtifact = result
    receipt.checks.result = status.code === 0 && !status.timedOut && !status.overflow && readyStatus(status.stdout) &&
      diff.code === 0 && !diff.timedOut && !diff.overflow && result !== null
      ? check('passed', 'synthetic result diff read back; does not prove model/usage or laptop-off continuation')
      : check('blocked', 'synthetic result not yet read back; rerun with the same receipt to inspect the existing task')
    receipt.phase = receipt.checks.result.status === 'passed' ? 'finished' : 'submitted'
    await save()
    return receipt
  } finally {
    await lock.close()
    await storage.verify()
    const info = await maybeStat(lockPath)
    if (info && sameFile(lockIdentity, info)) await unlink(lockPath)
  }
}
