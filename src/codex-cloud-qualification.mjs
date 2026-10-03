import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runProcess } from './process-runner.mjs'

export const CLOUD_SAMPLE_PROMPT = 'Synthetic factory runtime qualification only. Do not use subagents, credentials, external services, product data, commits, PRs or deployment. In this disposable workspace compute 19 + 23 and write qualification-result.json containing exactly {"sum":42}. Read it back and verify sum is 42. Report the result. Do not modify other files.'
const check = (status, reason) => ({ status, reason })
const unknown = reason => check('unverified', reason)
const hashBytes = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const digest = value => hashBytes(JSON.stringify(value))
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)
const redact = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
  .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
  .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)\s*[=:]\s*)\S+/gi, '$1[redacted]')

async function persist(file, value) {
  const { receiptDigest: ignored, ...content } = value
  value.receiptDigest = digest(content)
  const temp = `${file}.tmp`
  const handle = await open(temp, 'w', 0o600)
  try { await handle.chmod(0o600); await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync() }
  finally { await handle.close() }
  await rename(temp, file)
}

function sampleResult(diff) {
  const sections = diff.split(/(?=^diff --git )/m).filter(section =>
    section.split('\n')[0] === 'diff --git a/qualification-result.json b/qualification-result.json')
  if (sections.length !== 1) return null
  const bytes = sections[0].split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n')
  try {
    const value = JSON.parse(bytes)
    return value.sum === 42 && Object.keys(value).length === 1 ? { bytes, digest: hashBytes(bytes) } : null
  } catch { return null }
}

function requestFor({ sourceRevision, model, effort, environment = null, settingsBinding = null }) {
  if (!/^[a-f0-9]{40,64}$/.test(sourceRevision ?? '')) throw new Error('exact sourceRevision required')
  if (!validId(model) || !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('invalid model or effort')
  if (environment !== null && (!validId(environment.id) || environment.factoryOnly !== true ||
      environment.repository !== 'jbookout/software-factory' || !/^[A-Za-z0-9][A-Za-z0-9/._-]{0,199}$/.test(environment.branch ?? ''))) {
    throw new Error('an explicitly selected factory-only environment and branch are required')
  }
  if (settingsBinding !== null && (!validId(settingsBinding.userId) || !validId(settingsBinding.workerId) ||
      !Number.isInteger(settingsBinding.version) || settingsBinding.version < 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(settingsBinding.settingsDigest ?? ''))) throw new Error('invalid settings binding')
  return { sourceRevision, model, effort, environment, settingsBinding, sampleDigest: hashBytes(CLOUD_SAMPLE_PROMPT) }
}

// Qualification is intentionally fail-closed for this CLI surface. Observation is
// not certification: local deadlines never prove remote cancellation/timeout,
// local config never proves the cloud's model, and login never proves entitlement.
export async function qualifyCodexCloud(options) {
  const { stateFile, codexCommand = ['codex'], cwd, timeoutMs = 30_000 } = options
  if (!stateFile || !Array.isArray(codexCommand) || !codexCommand.length ||
      codexCommand.some(s => typeof s !== 'string' || !s) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('stateFile, command and bounded timeoutMs required')
  }
  const request = requestFor(options)
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 })
  const lock = await open(`${stateFile}.lock`, 'wx', 0o600)
  let receipt
  try {
    try { receipt = JSON.parse(await readFile(stateFile, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (receipt) {
      if (receipt.schema !== 'codex-cloud-qualification.v1' || receipt.requestDigest !== digest(request)) throw new Error('qualification request changed; use a new private receipt')
      const { receiptDigest, ...content } = receipt
      if (receipt.qualified !== false || receiptDigest !== digest(content) || digest(receipt.request) !== digest(request) ||
          !['preflight', 'submission-pending', 'submitted', 'finished'].includes(receipt.phase)) throw new Error('invalid stored receipt; verify the original observations before recovery')
      // An interrupted submission may have reached the cloud. Never retry it.
      if (receipt.phase === 'submission-pending' && !receipt.taskId) {
        receipt.checks.submission = check('blocked', 'submission outcome unknown: inspect cloud tasks before any new attempt')
        await persist(stateFile, receipt)
      }
      if (!receipt.taskId || receipt.phase === 'finished') return receipt
    } else {
      receipt = { schema: 'codex-cloud-qualification.v1', request, requestDigest: digest(request),
        startedAt: new Date().toISOString(), phase: 'preflight', taskId: null, qualified: false, probes: [],
        checks: Object.fromEntries(['submission', 'result', 'actualModel', 'actualEffort', 'usage', 'resume', 'cancel',
          'remoteTimeout', 'laptopIndependent', 'entitlement', 'expiryRecovery'].map(name => [name, unknown('not observed on this account and cloud task')])),
        dependentRoutes: {
          'claude-subscription': check('blocked', 'Claude execution prohibited for this build; persistent-host subscription judgment and expiry/limits remain unqualified'),
          'dot-chatgpt': check('blocked', 'programmatic research/import route and account entitlement unqualified'),
          'grok-research': check('blocked', 'research/import route unqualified by this harness')
        } }
      await persist(stateFile, receipt)
    }
    // Do not inherit paid API credentials or unrelated process secrets.
    const env = Object.fromEntries(['HOME', 'PATH', 'CODEX_HOME', 'TMPDIR', 'SystemRoot', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
    const probe = async (name, args, projection = text => redact(text)) => {
      const start = Date.now()
      let result
      try { result = await runProcess([...codexCommand, ...args], { cwd, env, timeoutMs, maxOutputBytes: 64_000 }) }
      catch (error) { result = { code: 1, timedOut: false, overflow: false, stdout: '', stderr: `process unavailable: ${error.code ?? 'unknown'}` } }
      const output = `${result.stdout}\n${result.stderr}`.trim()
      receipt.probes.push({ name, args, code: result.code, timedOut: result.timedOut, overflow: result.overflow,
        durationMs: Date.now() - start, observedAt: new Date().toISOString(), output: projection(output) })
      await persist(stateFile, receipt)
      return { ...result, output }
    }
    const login = await probe('authentication', ['login', 'status'], output =>
      /Logged in using ChatGPT/.test(output) ? 'Logged in using ChatGPT' : 'subscription login not confirmed')
    if (login.code !== 0 || !/Logged in using ChatGPT/.test(login.output)) {
      receipt.checks[receipt.taskId ? 'result' : 'submission'] = check('blocked', 'ChatGPT authentication failed; no API fallback')
      if (!receipt.taskId) receipt.phase = 'finished'
      await persist(stateFile, receipt)
      return receipt
    }
    if (!receipt.taskId) {
      const version = await probe('version', ['--version'])
      receipt.cliVersion = version.output.trim()
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
      if (help.code !== 0 || version.code !== 0) {
        receipt.checks.submission = check('blocked', 'ChatGPT authentication or CLI preflight failed; no API fallback')
        receipt.phase = 'finished'
        await persist(stateFile, receipt)
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
        await persist(stateFile, receipt)
        return receipt
      }
      const args = ['cloud', 'exec', '--attempts', '1',
        '-c', `model=${JSON.stringify(request.model)}`, '-c', `model_reasoning_effort=${JSON.stringify(request.effort)}`]
      if (request.environment) args.push('--env', request.environment.id, '--branch', request.environment.branch)
      args.push(CLOUD_SAMPLE_PROMPT)
      // Persist before the external call, including for a timeout/lost response.
      receipt.phase = 'submission-pending'
      await persist(stateFile, receipt)
      const submit = await probe('submission', args)
      receipt.taskId = submit.stdout.match(/https:\/\/chatgpt\.com\/codex\/tasks\/(task_[A-Za-z0-9_-]+)/)?.[1] ?? null
      if (!receipt.taskId) {
        receipt.checks.submission = check('blocked', request.environment
          ? 'submission outcome unknown: inspect cloud tasks before retry; no task ID was read back'
          : 'factory-only environment missing; CLI submission refused without --env')
        // No selected environment means the CLI cannot submit. With an environment
        // an ambiguous call stays pending so a later invocation never resubmits.
        receipt.phase = request.environment ? 'submission-pending' : 'finished'
        await persist(stateFile, receipt)
        return receipt
      }
      receipt.checks.submission = check('passed', 'cloud task ID read from CLI response; entitlement/usage still unverified')
      receipt.phase = 'submitted'
      await persist(stateFile, receipt)
    }
    if (!/^task_[A-Za-z0-9_-]+$/.test(receipt.taskId)) throw new Error('invalid stored cloud task ID')
    const status = await probe('task-status', ['cloud', 'status', receipt.taskId])
    const diff = await probe('task-diff', ['cloud', 'diff', receipt.taskId])
    const result = sampleResult(diff.stdout)
    receipt.resultArtifact = result
    receipt.checks.result = status.code === 0 && /\[READY\]/.test(status.stdout) && diff.code === 0 && result !== null
      ? check('passed', 'synthetic result diff read back; does not prove model/usage or laptop-off continuation')
      : check('blocked', 'synthetic result not yet read back; rerun with the same receipt to inspect the existing task')
    receipt.phase = receipt.checks.result.status === 'passed' ? 'finished' : 'submitted'
    await persist(stateFile, receipt)
    return receipt
  } finally { await lock.close(); await unlink(`${stateFile}.lock`) }
}
