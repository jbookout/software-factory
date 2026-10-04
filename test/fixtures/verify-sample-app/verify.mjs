// Product-owned VERIFY runner for the slice-4 sample app: Launch, Doctor, Drive,
// Evidence, Cleanup. It drives the user route over HTTP, so its engine is the
// sample's own driver, never e2e's web engine; Prove refuses it for acceptance.
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

export const SAMPLE_ENGINE = 'sample-http-user-path@1'
const EXPECTATION = 'a submitted task is listed and read back from storage'
const ORACLE = 'POST the entry form, then require the title in /tasks AND in read-store.mjs output'
const APP_FILES = ['lib.mjs', 'lib.unit.mjs', 'server.mjs', 'read-store.mjs']
const run = promisify(execFile)
const sha = text => createHash('sha256').update(text).digest('hex')

/** Builds the app into outDir; the planted defect skips persistence while unit tests stay green. */
export async function buildSampleApp({ outDir, revision, defect }) {
  if (defect !== null && defect !== 'skip-persist') throw new Error(`unknown defect ${defect}`)
  await fs.mkdir(outDir, { recursive: true })
  const hash = createHash('sha256')
  for (const name of APP_FILES) {
    let text = await fs.readFile(new URL(`./app/${name}`, import.meta.url), 'utf8')
    if (defect && name === 'server.mjs') {
      if (!text.includes('await persist()')) throw new Error('planted defect site missing')
      text = text.replace('await persist()', 'void persist /* planted defect: never written */')
    }
    await fs.writeFile(path.join(outDir, name), text)
    hash.update(`${name}\0${text}\0`)
  }
  const buildDigest = hash.digest('hex')
  await fs.writeFile(path.join(outDir, 'build.json'), JSON.stringify({ revision, buildDigest }))
  return { dir: outDir, revision, buildDigest, buildConfigDigest: sha(JSON.stringify({ host: '127.0.0.1', defect })), defect }
}

const jsonBlock = text => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)?.[1] ?? 'null')
export async function loadFeatureMap(skillDir) {
  const index = jsonBlock(await fs.readFile(new URL('SKILL.md', skillDir), 'utf8'))
  const features = await Promise.all(index.features.map(async feature =>
    jsonBlock(await fs.readFile(new URL(feature.file, skillDir), 'utf8'))))
  return { index, features }
}

async function launch(build, dataFile) {
  const child = spawn(process.execPath, [path.join(build.dir, 'server.mjs'), '--serve', '--data', dataFile],
    { stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = once(child, 'exit')
  let output = ''
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('launch timed out')), 10_000)
    child.stdout.on('data', chunk => {
      output += chunk
      const match = /listening (\d+)/.exec(output)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)) })
  })
  return { child, exited, port }
}

export async function runVerify({ build, feature, evidenceRoot, scratchParent, criterionId, role, skip = [] }) {
  const runId = randomUUID()
  const scratchDir = await fs.mkdtemp(path.join(scratchParent, 'verify-run-'))
  const dataFile = path.join(scratchDir, 'tasks.json')
  await fs.mkdir(path.join(evidenceRoot, runId))
  const put = async (name, content) => {
    const bytes = typeof content === 'string' ? content : JSON.stringify(content)
    await fs.writeFile(path.join(evidenceRoot, runId, name), bytes)
    return { ref: `${runId}/${name}`, digest: sha(bytes) }
  }
  const binding = { projectId: 'sample-task-web', version: 1, contractRevision: 1,
    contractDigest: sha('sample design contract r1'), sourceCommit: build.revision, buildDigest: build.buildDigest,
    buildConfigDigest: build.buildConfigDigest, platform: 'web', engine: SAMPLE_ENGINE, targetId: 'node-http/127.0.0.1' }
  const oracle = await put('oracle.txt', ORACLE)
  const records = []
  const record = async (entry, fields) => records.push(await put(`check-${entry.id}.json`, {
    schema: 'design-check.v1', criterionId, role, binding,
    fixture: { id: 'empty-store', revision: 1, digest: sha('[]') }, actor: 'sample owner',
    startingState: 'empty isolated task store', steps: feature.userRoute, expected: EXPECTATION,
    method: 'e2e', oracle, entryPoint: entry.id, finding: null, persistence: null, ...fields }))

  const { child, exited, port } = await launch(build, dataFile)
  const base = `http://127.0.0.1:${port}`
  try {
    const health = await (await fetch(`${base}/health`)).json()
    const doctor = [
      health.revision !== build.revision && `doctor: running revision ${health.revision} is not ${build.revision}`,
      health.buildDigest !== build.buildDigest && `doctor: running build ${health.buildDigest} is not ${build.buildDigest}`,
      health.pid !== child.pid && 'doctor: server process is not owned by this run'
    ].filter(Boolean)
    for (const entry of feature.entryPoints) {
      if (doctor.length || skip.includes(entry.id)) {
        const observed = doctor.length ? doctor.join('; ') : `entry point ${entry.id} was not driven`
        await record(entry, { entryPointStatus: doctor.length ? 'blocked' : 'skipped', outcome: 'blocked', observed,
          artifacts: [await put(`${entry.id}-not-driven.json`, { observed })] })
        continue
      }
      const title = `Buy milk via ${entry.id}`
      const formId = /^form#([\w-]+)$/.exec(entry.handles[0])?.[1]
      const html = await (await fetch(`${base}${entry.route}`)).text()
      const action = new RegExp(`<form id="${formId}"[^>]*action="([^"]+)"`).exec(html)?.[1]
      const response = action ? await fetch(`${base}${action}`, { method: 'POST', redirect: 'manual',
        body: new URLSearchParams({ title }) }) : null
      const list = await (await fetch(`${base}/tasks`)).text()
      const listed = list.includes(`<li>${title}</li>`)
      const { stdout } = await run(process.execPath, [path.join(build.dir, 'read-store.mjs'), '--read', dataFile])
      const stored = JSON.parse(stdout)
      const saved = stored.includes(title)
      await record(entry, {
        entryPointStatus: 'exercised', outcome: action && listed && saved ? 'passed' : 'failed',
        observed: `${action ? 'form submitted' : `form ${formId} missing`}; ${listed ? 'list shows the task' : 'list lacks the task'}; ` +
          `${saved ? 'storage read-back has the task' : 'storage read-back lacks the task'}`,
        finding: !action ? `form ${formId} missing` : !listed ? 'task missing from the list'
          : !saved ? 'task missing from storage readback' : null,
        artifacts: [await put(`${entry.id}-assertion.json`, { title, action, status: response?.status ?? null,
          location: response?.headers.get('location') ?? null, listed, saved })],
        persistence: { writtenValue: await put(`${entry.id}-list.html`, list),
          independentReadback: await put(`${entry.id}-store.json`, stdout),
          readbackMethod: 'read-store.mjs reads the data file in a separate process' }
      })
    }
  } finally {
    // Cleanup: only the process and scratch directory this run created.
    child.kill()
    await exited
    await fs.rm(scratchDir, { recursive: true })
  }
  return { records, port, scratchDir }
}
