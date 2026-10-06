import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DeliveryError, keyFor, readJson, writeJson, withLease } from './pr-delivery-state.mjs'

const text = file => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
const lines = value => value.split('\n').filter(Boolean)
const hash = value => createHash('sha256').update(value).digest('hex')

// Cutover imports intent, never approval authority. Consumers observe GitHub and
// reconcile retained worktrees before any dispatch or mutation.
export async function importLegacyDelivery(config, root) {
  for (const name of ['merge-queue.txt','merge-queue.done']) if (!(await fs.stat(path.join(root,name))).isFile())
    throw new DeliveryError('legacy queue source must be a regular file',9)
  if (!(await fs.stat(path.join(root,'budget'))).isDirectory()) throw new DeliveryError('legacy budget source must be a directory',9)
  const queued = lines(await text(path.join(root, 'merge-queue.txt')))
  const done = new Set(lines(await text(path.join(root, 'merge-queue.done'))))
  if ([...done].some(line => !queued.includes(line))) throw new DeliveryError('legacy done entry missing from queue; reconcile before cutover',9)
  const pending = queued.filter(line => !done.has(line)).map(line => {
    const match = /^(\S+) (\d+) ([0-9a-f]{40})(?: (.*))?$/.exec(line)
    if (!match || !config.repos[match[1]]) throw new DeliveryError('invalid legacy queue repository or entry', 9)
    return { repo: match[1], pr: Number(match[2]), head: match[3], note: match[4] ?? '' }
  })
  const jobs = new Map(), usage = []
  const repos = Object.keys(config.repos)
  const identify = (name, pattern) => {
    const match = pattern.exec(name)
    if (!match) return null
    const matching = repos.filter(repo => repo.split('/')[1] === match[1])
    if (matching.length > 1) throw new DeliveryError('ambiguous legacy repository name', 9)
    return matching[0] ? { repo: matching[0], pr: Number(match[2]) } : null
  }
  for (const name of await fs.readdir(path.join(root, 'budget')).catch(e => { if (e.code === 'ENOENT') return []; throw e })) {
    const job = identify(name, /^(.+)-(\d+)\.log$/)
    if (!job) continue
    for (const [index, line] of lines(await text(path.join(root, 'budget', name))).entries()) {
      const [seconds, kind] = line.split(' '), at = Number(seconds) * 1000
      if (!Number.isSafeInteger(at) || !kind) throw new DeliveryError('invalid legacy usage record', 9)
      if (at >= Date.now() - 86400_000) usage.push({ ...job, kind, at, legacyId: hash(`${root}:${name}:${index}:${line}`) })
    }
  }
  for (const name of await fs.readdir(root)) {
    const job = identify(name, /^loop-(.+)-(\d+)\.log$/)
    if (job) jobs.set(keyFor(job.repo, job.pr), { ...job, legacyLog: path.join(root, name),
      lastStatus: lines(await text(path.join(root, name))).at(-1) ?? '', status: 'pending', source: 'legacy-loop' })
  }
  for (const name of await fs.readdir(path.join(root, 'locks')).catch(e => { if (e.code === 'ENOENT') return []; throw e })) {
    const job = identify(name, /^pr-loop-(.+)-(\d+)\.pid$/)
    if (job) jobs.set(keyFor(job.repo, job.pr), { ...jobs.get(keyFor(job.repo, job.pr)), ...job, status: 'pending', source: 'legacy-lock' })
  }
  for (const job of pending) jobs.set(keyFor(job.repo, job.pr), { ...jobs.get(keyFor(job.repo, job.pr)), ...job, status: 'pending', source: 'legacy-queue' })
  await withLease(path.join(config.stateDir, 'locks'), 'legacy-import', async () => {
    const file = path.join(config.stateDir, 'queue.json'), queue = await readJson(file, [])
    for (const entry of pending) if (!queue.some(old => old.repo === entry.repo && old.pr === entry.pr && old.head === entry.head))
      queue.push({ ...entry, id: randomUUID(), state: 'pending', attempts: 0, availableAt: 0, outcome: null, imported: true })
    await writeJson(file, queue)
    const usageFile = path.join(config.stateDir, 'usage.json'), previous = await readJson(usageFile, [])
    await writeJson(usageFile, [...previous, ...usage.filter(row => !previous.some(old => old.legacyId === row.legacyId))])
    const inflight = await readJson(path.join(config.stateDir, 'inflight.json'), {})
    for (const [key, job] of jobs) inflight[key] ??= job
    await writeJson(path.join(config.stateDir, 'inflight.json'), inflight)
  }, { waitMs: config.commandTimeoutMs ?? 5000, pollMs: config.pollMs ?? 20 })
  return { pending: pending.length, inflight: jobs.size, usage: usage.length, message: `IMPORTED ${pending.length} queue entries, ${jobs.size} PR states, ${usage.length} usage records; source unchanged` }
}
