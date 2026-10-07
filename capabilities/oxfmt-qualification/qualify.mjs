import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess } from '../../src/process-runner.mjs'
import { verificationSource } from '../../src/local-verification.mjs'
import { installOxfmt, sha, VERSION } from './install.mjs'
import { assertSemanticParity } from './semantics.mjs'
import { assertHtmlParity } from './html.mjs'

export const CORPUS = [
  ['js', 'capabilities/client-presentation/assets/site/finance.js'],
  ['mjs', 'src/canonical.mjs'],
  ['ts', 'src/design-manager.d.mts'],
  ['tsx', 'capabilities/tailwind-design-system-lint/fixture/src/valid.tsx'],
  ['json', 'config/ci-efficiency-trials.v1.json'],
  ['yaml', '.github/workflows/ci.yml'],
  ['html', 'capabilities/agentic-ui-evaluation/fixture/repaired.html'],
  ['css', 'capabilities/tailwind-design-system-lint/fixture/src/theme.css']
]
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url))
const json = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })

export function nativeHtmlUnsupported(kind, result, unchanged) {
  return kind === 'html' && result.code === 2 && unchanged &&
    (result.stdout + result.stderr).includes('Expected at least one target file')
}

export function peakRssBytes(report, platform) {
  const pattern = platform === 'darwin' ? /^\s*(\d+)\s+maximum resident set size\s*$/gm :
    /^[ \t]*Maximum resident set size \(kbytes\):[ \t]*(\d+)[ \t]*$/gm
  const matches = [...report.matchAll(pattern)]
  assert.equal(matches.length, 1, 'resource measurement missing or ambiguous')
  return Number(matches[0][1]) * (platform === 'darwin' ? 1 : 1024)
}

async function measured(command, args, cwd, label) {
  const started = performance.now()
  const reportFile = path.join(cwd, `${label}.rusage`)
  await fs.writeFile(reportFile, '', { flag: 'wx', mode: 0o600 })
  const result = await runProcess(['/usr/bin/time', process.platform === 'darwin' ? '-l' : '-v', '-o', reportFile,
    ...command, '--disable-nested-config', '--threads=2', ...args],
  { cwd, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, timeoutMs: 30000 })
  const log = `${label}.log`, bytes = result.stdout + result.stderr
  await fs.writeFile(path.join(cwd, log), bytes, { flag: 'wx', mode: 0o600 })
  const report = await fs.readFile(reportFile, 'utf8')
  return { ...result, measurement: { exitCode: result.code, controllerWallMs: performance.now() - started,
    peakRssBytes: peakRssBytes(report, process.platform), resourceReport: path.basename(reportFile),
    resourceReportDigest: sha(report), log, logDigest: sha(bytes) } }
}

/** Execute a real formatter against a copy; unchanged/skipped files cannot pass. */
export async function qualifyFile({ kind, source, directory, command, distribution, samples = 3 }) {
  assert(Number.isInteger(samples) && samples >= 1 && samples <= 10, 'invalid sample count')
  assert((await fs.lstat(source)).isFile(), 'source must be a regular file')
  const original = await fs.readFile(source), seeded = Buffer.from(original.toString().replace(/\n*$/, '\n\n\n\n'))
  await fs.mkdir(directory)
  const filename = path.basename(source), target = path.join(directory, filename)
  await fs.writeFile(path.join(directory, 'before.txt'), seeded, { flag: 'wx' })
  await fs.writeFile(target, seeded, { flag: 'wx' })
  const beforeDigest = sha(seeded), precheck = await measured(command, ['--check', filename], directory, 'precheck')
  if (distribution === 'native' && nativeHtmlUnsupported(kind, precheck, sha(await fs.readFile(target)) === beforeDigest))
    return { kind, distribution, status: 'unsupported', fallback: 'npm', sourceDigest: sha(original), beforeDigest, precheck: precheck.measurement }
  assert.equal(precheck.code, 1, 'seeded formatting must be detected, not ignored')
  const observations = []; let formatted
  for (let i = 0; i < samples; i++) {
    if (i) await fs.writeFile(target, seeded)
    const run = await measured(command, ['--write', filename], directory, `format-${i}`)
    assert.equal(run.code, 0, 'formatter write failed')
    const bytes = await fs.readFile(target)
    assert.notEqual(sha(bytes), beforeDigest, 'formatter skipped the seeded input')
    if (formatted) assert.equal(sha(bytes), sha(formatted), 'format result changed across observations')
    formatted = bytes
    observations.push({ sequence: i + 1, cacheState: i ? 'repeated-process' : 'first-process', ...run.measurement })
  }
  const second = await measured(command, ['--write', filename], directory, 'idempotence')
  assert.equal(second.code, 0); assert.equal(sha(await fs.readFile(target)), sha(formatted), 'not idempotent')
  const postcheck = await measured(command, ['--check', filename], directory, 'postcheck')
  assert.equal(postcheck.code, 0)
  const semantic = kind === 'html' ? await assertHtmlParity(seeded.toString(), formatted.toString()) :
    await assertSemanticParity(kind, seeded.toString(), formatted.toString(), filename).then(() => ({ state: 'bounded-parity-passed' }))
  return { kind, distribution, status: 'fixture-qualified', sourceDigest: sha(original), beforeDigest,
    afterDigest: sha(formatted), observations, precheck: precheck.measurement,
    idempotence: second.measurement, postcheck: postcheck.measurement, semantic }
}

export async function runQualification() {
  const directory = await fs.mkdtemp(path.join(process.env.FACTORY_ATTEMPT_DIR ?? os.tmpdir(), 'oxfmt-'))
  const receipt = { schema: 'oxfmt-qualification/v1', status: 'running', version: VERSION,
    source: await verificationSource(sourceRoot), directory, samplesPerFile: 3, rows: [], installers: [],
    scope: 'Eight declared copied Factory fixtures; no repository-wide formatting or semantic guarantee',
    measurementLimits: 'Single host, three formatter observations per file and two installer observations. Fresh copies/owned caches do not flush host or upstream caches. Controller wall includes supervisor overhead. RSS is OS time rusage; no speedup or adoption claim.' }
  try {
    const options = { archiveCache: path.join(directory, 'archive-cache.tar.gz'), npmCache: path.join(directory, 'npm-cache') }
    const first = await installOxfmt({ ...options, directory: path.join(directory, 'first-install') })
    receipt.installers.push(first.receipt)
    const warm = await installOxfmt({ ...options, directory: path.join(directory, 'repeated-install') })
    receipt.installers.push(warm.receipt)
    const corpus = path.join(directory, 'corpus'); await fs.mkdir(corpus)
    for (const [kind, relative] of CORPUS) {
      const rows = []
      for (const distribution of ['native', 'npm']) {
        const row = await qualifyFile({ kind, source: path.join(sourceRoot, relative),
          directory: path.join(corpus, `${distribution}-${kind}`), command: first.commands[distribution], distribution })
        row.sourcePath = relative; rows.push(row); receipt.rows.push(row)
      }
      assert.equal(rows[1].status, 'fixture-qualified', 'npm fallback must qualify every declared format')
      if (rows[0].status === 'fixture-qualified') assert.equal(rows[0].afterDigest, rows[1].afterDigest, 'distribution output differs')
      else assert.equal(kind, 'html', 'unexpected native coverage loss')
    }
    // Parse failures must stay visible; they must never enter the HTML fallback.
    const invalid = path.join(directory, 'invalid'); await fs.mkdir(invalid)
    await fs.writeFile(path.join(invalid, 'broken.js'), 'const = ;\n')
    receipt.invalidControls = []
    for (const distribution of ['native', 'npm']) {
      const result = await measured(first.commands[distribution], ['--check', 'broken.js'], invalid, distribution)
      assert.equal(result.code, 2); assert(!nativeHtmlUnsupported('js', result, true))
      receipt.invalidControls.push({ distribution, ...result.measurement })
    }
    assert.deepEqual(await verificationSource(sourceRoot), receipt.source, 'source changed during qualification')
    receipt.status = 'fixture-qualified'
  } catch (error) { receipt.status = 'failed'; receipt.reason = error.message }
  await json(path.join(directory, 'receipt.json'), receipt)
  console.log(JSON.stringify(receipt))
  if (receipt.status !== 'fixture-qualified') throw new Error(`Oxfmt qualification failed; ${directory}/receipt.json: ${receipt.reason}`)
  return receipt
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runQualification()
