import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import Ajv from 'ajv/dist/2020.js'
import { createArtifactReader } from '../../src/evidence.mjs'
import { E2E_PIN, e2eEnvironment, normalizeE2eReport, qualifyAgenticEvaluation } from './wrapper.mjs'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('./fixture/', import.meta.url))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

async function files(dir) {
  const result = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name)
    if (entry.isDirectory()) result.push(...await files(name))
    else if (entry.isFile()) result.push(name)
    else throw new Error(`unsupported evidence entry ${name}`)
  }
  return result.sort()
}

async function runCli(env, log) {
  const child = spawn(process.execPath, [path.join(root, 'node_modules/e2e/dist/cli/bin.js'),
    'run', '--output', '.output'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const timer = setTimeout(() => child.kill('SIGTERM'), 90000)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => signal ? reject(new Error(`e2e stopped: ${signal}`)) : resolve(code))
    })
    await fs.writeFile(log, JSON.stringify({ code, stdout, stderr }, null, 2))
    return code
  } finally { clearTimeout(timer) }
}

/** Execute the frozen fixture with published packages, archive, then judge it. */
export async function runDeterministicQualification() {
  const started = performance.now()
  const archiveRoot = path.join(root, '.qualification', randomUUID())
  await fs.mkdir(archiveRoot, { recursive: true })
  const manifestBytes = await fs.readFile(path.join(root, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  const suite = await fs.readFile(path.join(root, 'journeys.e2e.mts'))
  const config = await fs.readFile(path.join(root, 'e2e.config.mts'))
  const lockBytes = await fs.readFile(path.join(root, 'package-lock.json'))
  const lock = JSON.parse(lockBytes)
  for (const [name, version] of [['e2e', E2E_PIN.version], ['@e2e-dev/web', '0.11.2'], ['playwright', '1.63.0']]) {
    assert.equal(lock.packages[`node_modules/${name}`].version, version)
    const installed = JSON.parse(await fs.readFile(path.join(root, 'node_modules', name, 'package.json')))
    assert.equal(installed.version, version)
  }
  assert.ok(!lock.packages['node_modules/ai'], 'deterministic fixture must not install a model gateway')
  const schema = JSON.parse(await fs.readFile(path.join(root, 'node_modules/e2e/schema/report-v1.schema.json')))
  const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema)
  const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  const sourceDirty = Boolean((await exec('git', ['status', '--porcelain', '--', 'capabilities/agentic-ui-evaluation',
    'src/design-verify.mjs', 'src/design-verify.d.mts'], { cwd: path.resolve(root, '../../..') })).stdout.trim())
  const runs = {}
  for (const [name, build] of [['broken', 'broken'], ['repaired', 'repaired'], ['replay', 'broken']]) {
    const html = await fs.readFile(path.join(root, `${build}.html`))
    const candidate = { sourceCommit, buildDigest: sha(Buffer.concat([html, suite, config, manifestBytes, lockBytes])) }
    let helpVisits = 0
    const server = createServer((req, res) => {
      if (req.url === '/help-visits') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(helpVisits)); return }
      if (req.url === '/help' && req.headers['sec-fetch-dest'] === 'document') helpVisits++
      res.setHeader('Content-Type', 'text/html')
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'")
      res.end(html)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const dest = path.join(archiveRoot, name)
    await fs.mkdir(dest)
    const callLog = path.join(dest, 'provider-invocations.log')
    await fs.writeFile(callLog, 'counter-start\n')
    // No inherited credential env, no model gateway, no OAuth imports or store reads.
    const env = e2eEnvironment({ PATH: process.env.PATH, LANG: 'C.UTF-8',
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
      FIXTURE_URL: `http://127.0.0.1:${server.address().port}`, PROVIDER_CALL_LOG: callLog,
      NODE_OPTIONS: `--import=${fileURLToPath(new URL('./no-provider.mjs', import.meta.url))}`,
      CI: '1', XDG_CONFIG_HOME: path.join(archiveRoot, 'empty-config') }, name === 'replay' ? 'replay' : 'run')
    try {
      const exitCode = await runCli(env, path.join(dest, 'cli.json'))
      await fs.cp(path.join(root, '.output'), path.join(dest, 'output'), { recursive: true })
      assert.ok(exitCode === 0 || exitCode === 1, `e2e startup/tool failure (${exitCode}); see archived cli.json`)
      const report = JSON.parse(await fs.readFile(path.join(dest, 'output/report.json')))
      assert.ok(validate(report), JSON.stringify(validate.errors))
      assert.equal(report.run.targets.length, 1)
      assert.equal(report.run.targets[0].engine.version, '0.11.2')
      const normalized = normalizeE2eReport({ report, candidate, manifest,
        test: { ref: 'journeys.e2e.mts', digest: sha(suite) } })
      const expectedFailed = build === 'broken' ? manifest.defects.map(defect => defect.id).sort() : []
      assert.deepEqual(normalized.reruns.filter(run => run.outcome !== 'passed').map(run => run.id).sort(), expectedFailed)
      assert.equal(exitCode, expectedFailed.length ? 1 : 0)
      assert.equal(report.run.usage.modelTokens, 0)
      const providerInvocations = (await fs.readFile(callLog, 'utf8')).split('\n').filter(line => line === 'external-invocation').length
      assert.equal(providerInvocations, 0)
      runs[name] = { ...normalized, providerInvocations, summary: report.run.summary,
        durationMs: Date.parse(report.run.finishedAt) - Date.parse(report.run.startedAt) }
      // Delete only disposable output under this git worktree, after archiving it.
      await fs.rm(path.join(root, '.output'), { recursive: true })
    } finally { await new Promise(resolve => server.close(resolve)) }
  }
  await fs.writeFile(path.join(archiveRoot, 'manifest.json'), manifestBytes)
  await fs.writeFile(path.join(archiveRoot, 'journeys.e2e.mts'), suite)
  await fs.writeFile(path.join(archiveRoot, 'normalized-runs.json'), JSON.stringify(runs, null, 2))
  const refs = []
  for (const file of await files(archiveRoot)) refs.push({ ref: path.relative(archiveRoot, file), digest: sha(await fs.readFile(file)) })
  const result = await qualifyAgenticEvaluation({ manifest, ...runs,
    archive: { refs, readArtifact: createArtifactReader(archiveRoot), limits: { timeoutMs: 60000 } } })
  const receipt = { schema: 'e2e-deterministic-qualification.v1', status: result.status,
    scope: 'deterministic web wrapper; attended model exploration remains unqualified',
    pin: E2E_PIN, companions: { web: '0.11.2', playwright: '1.63.0', node: process.version },
    sourceCommit, sourceDirty, manifestDigest: sha(manifestBytes), suiteDigest: sha(suite),
    lockDigest: sha(lockBytes), candidates: { broken: runs.broken.candidate, repaired: runs.repaired.candidate },
    runs: Object.fromEntries(Object.entries(runs).map(([name, run]) => [name, { summary: run.summary,
      providerInvocations: run.providerInvocations, durationMs: run.durationMs }])),
    archivedEvidence: refs, archiveRoot, reasons: result.reasons,
    rejected: result.rejected.map(finding => ({ id: finding.id, reason: finding.reason })),
    durationMs: Math.round(performance.now() - started), evidenceStrength: result.evidenceStrength,
    attendedEvaluation: { status: 'blocked', checkpoint: 'attended-evaluation' } }
  await fs.writeFile(path.join(archiveRoot, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  assert.equal(result.status, 'qualified', result.reasons.join('\n'))
  return receipt
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runDeterministicQualification(), null, 2))
}
