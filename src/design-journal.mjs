// Scope is trusted host configuration, never a field of an MCP command.
// Python's standard-library SQLite preserves the factory's Node 20 baseline.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import Ajv2020 from 'ajv/dist/2020.js'
import { canonicalJson, canonicalDigest, deepFreeze } from './canonical.mjs'
import { runProcess } from './process-runner.mjs'
import { startDesignInterview, resumeDesignInterview, answerDesignInterview,
  proposeDesignScope, reassessDesignLayer } from './design-manager.mjs'

const ajv = new Ajv2020({ strict: true, allErrors: true })
const schemas = Object.fromEntries(['design-journal', 'design-project', 'design-verify'].map(name => {
  const schema = JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url)))
  ajv.addSchema(schema)
  return [name, schema.$id]
}))
const check = (schema, name) => ajv.getSchema(`${schemas[schema]}#/$defs/${name}`)
const recordChecks = { reference: check('design-journal', 'reference'), decision: check('design-journal', 'decision'),
  gate: check('design-project', 'gate'), 'worker-receipt': check('design-project', 'handoff'), evidence: check('design-verify', 'check') }
const nonblank = value => typeof value === 'string' && value.trim().length > 0
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const exact = (value, required) => {
  if (!plain(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key)))
    throw new Error('unknown command field or missing required field')
}
const scopeOf = options => {
  const { userId, projectId, version } = options
  if (![userId, projectId].every(nonblank) || !Number.isSafeInteger(version) || version < 1)
    throw new Error('user, project and positive version are required')
  return { userId, projectId, version }
}
const defaultRoot = () => join(homedir(), '.local/share/software-factory/design-manager')
const helper = fileURLToPath(new URL('./design-journal-store.py', import.meta.url))
async function store(request) {
  const result = await runProcess(['python3', helper], { input: JSON.stringify(request), timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024 * 1024 })
  if (result.timedOut || result.overflow) throw new Error('journal outcome unknown: reread or retry the same idempotency key')
  let response
  try { response = JSON.parse(result.stdout) } catch { throw new Error('journal store returned no valid response') }
  if (result.code !== 0 || response?.error) throw new Error(response?.error ?? 'journal store failed')
  return response
}
const dateOnly = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value
const instant = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && dateOnly(value.slice(0, 10))
function validateReference(record) {
  const fail = reason => { throw new Error(`invalid reference: ${reason}`) }
  let url
  try { url = new URL(record.source.url) } catch { fail('source URL required') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('public source URL required')
  if (!dateOnly(record.source.sourceDate) || !instant(record.source.inspectedAt)) fail('source/date must be valid')
  const claims = { still: 'appearance', recording: 'transition', live: 'behavior',
    'inspected-source': 'implementation', 'vendor-claim': 'vendor-claim' }
  if (record.claim !== 'unverified' && record.claim !== claims[record.label]) fail('label exceeds observed scope')
  if (record.origin !== 'captured' && !['still', 'recording'].includes(record.label)) fail('generated/reconstructed material cannot be live or inspected source')
  if (record.origin !== 'captured' && !['appearance', 'unverified'].includes(record.claim)) fail('concepts are appearance evidence only')
  if (record.source.availability !== 'available' && record.claim !== 'unverified') fail('missing access remains unverified')
  if (record.source.availability === 'available' && !record.artifacts.length) fail('observed reference requires archived artifacts')
  if (record.reuse.status === 'copied' && ![record.reuse.license, record.reuse.permission].every(nonblank)) fail('copied assets require license and exact reuse permission')
  if (record.reviewerOutcome === 'rejected' && ![record.experiment.failedProperty, record.experiment.replacement].every(nonblank))
    fail('rejected experiment retains failed property and replacement')
}
function validateRecord(kind, record, scope) {
  const validate = recordChecks[kind]
  if (!validate || !validate(record)) throw new Error(`invalid ${kind} record: ${validate ? ajv.errorsText(validate.errors) : 'unknown kind'}`)
  if (kind === 'reference') validateReference(record)
  if (kind === 'evidence' && (record.binding.projectId !== scope.projectId || record.binding.version !== scope.version))
    throw new Error('evidence record belongs to another scope')
}
function artifactsIn(value) {
  if (!plain(value) && !Array.isArray(value)) return []
  if (plain(value) && nonblank(value.ref) && nonblank(value.digest)) return [{ ref: value.ref, digest: value.digest.replace(/^sha256:/, '') }]
  return Object.values(value).flatMap(artifactsIn)
}
const commandFields = {
  archive: ['bytes', 'origin'], append: ['kind', 'record'], 'start-interview': ['sourceRevision'],
  'answer-interview': ['response'], 'propose-scope': ['proposal'], 'reassess-layer': ['assessment']
}
function checkedState(state, scope) {
  for (const { kind, record } of state.records) validateRecord(kind, record, scope)
  if (state.view && !isDeepStrictEqual(resumeDesignInterview(state.view.interview), state.view))
    throw new Error('stored interview projection differs from replay')
  return deepFreeze(state)
}

/** Commands are JSON-shaped and scope-bound, ready for slice 7's authenticated MCP transport. */
export async function openDesignJournal(options) {
  exact(options, ['root', 'userId', 'projectId', 'version'].filter(key => key !== 'root' || Object.hasOwn(options, key)))
  const root = options.root ?? defaultRoot()
  const scope = scopeOf(options)
  const identity = await store({ op: 'open', root, scope })
  const call = request => store({ ...request, root: identity.root, identity, scope })
  const execute = async input => {
    const request = structuredClone(input)
    if (request?.command === 'read') { exact(request, ['command']); return checkedState(await call({ op: 'read' }), scope) }
    if (request?.command === 'backup') {
      exact(request, ['command', 'destination'])
      return call({ op: 'backup', destination: resolve(request.destination) })
    }
    const fields = commandFields[request?.command]
    if (!fields) throw new Error('unknown journal command')
    exact(request, ['command', 'expectedRevision', 'idempotencyKey', ...fields])
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 || !nonblank(request.idempotencyKey))
      throw new Error('expected revision and idempotency key required')
    const { bytes, ...metadata } = request
    const requestText = canonicalJson(request.command === 'archive' ? { ...metadata,
      artifactDigest: createHash('sha256').update(Buffer.from(bytes ?? '', 'base64')).digest('hex') } : request)
    const requestDigest = canonicalDigest(request)
    const replay = await call({ op: 'replay', key: request.idempotencyKey, requestDigest })
    if (replay !== null) return deepFreeze(replay)
    const state = checkedState(await call({ op: 'read' }), scope)
    if (state.revision !== request.expectedRevision) throw new Error('revision conflict: reread the project')
    let view = null
    let recordId = null
    if (request.command === 'append') {
      validateRecord(request.kind, request.record, scope)
      recordId = `${request.kind}:${request.record.id ?? canonicalDigest(request.record)}`
    } else if (request.command === 'archive') {
      if (typeof request.bytes !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.bytes)
        || Buffer.from(request.bytes, 'base64').length < 1 || Buffer.from(request.bytes, 'base64').length > 1024 * 1024)
        throw new Error('archive requires nonempty base64 bytes of at most 1 MiB')
      if (!['captured', 'generated', 'reconstructed', 'unspecified'].includes(request.origin))
        throw new Error('archive requires an explicit artifact origin')
    } else {
      if (request.command === 'start-interview') {
        if (state.view) throw new Error('interview already exists')
        view = startDesignInterview({ projectId: scope.projectId, sourceRevision: request.sourceRevision })
      } else {
        if (!state.view) throw new Error('start the interview first')
        const interview = state.view.interview
        view = request.command === 'answer-interview' ? answerDesignInterview(interview, request.response)
          : request.command === 'propose-scope' ? proposeDesignScope(interview, request.proposal)
            : reassessDesignLayer(interview, request.assessment)
      }
      const versionAnswer = view.interview.trace.find(event => event.question?.id === 'version' && event.answer.status === 'answered')
      if (versionAnswer && versionAnswer.answer.value !== scope.version) throw new Error('interview version differs from journal scope')
    }
    return deepFreeze(await call({ op: 'commit', request, requestText, requestDigest, recordId,
      viewText: view ? canonicalJson(view) : null,
      recordText: request.command === 'append' ? canonicalJson(request.record) : null,
      refs: artifactsIn(view ?? request.record) }))
  }
  return Object.freeze({ execute, readArtifact: async ref => {
    const encoded = await call({ op: 'artifact', ref })
    return Buffer.from(encoded, 'base64')
  } })
}

/** Administrative restore is separate from project commands and never overwrites a store. */
export async function restoreDesignJournal(options) {
  options = structuredClone(options)
  exact(options, ['root', 'backupRoot', 'userId', 'projectId', 'version'])
  const scope = scopeOf(options)
  const inspected = await store({ op: 'inspect-backup', backupRoot: options.backupRoot, scope })
  checkedState(inspected.snapshot, scope)
  await store({ op: 'restore', root: options.root, backupRoot: options.backupRoot, scope,
    databaseDigest: inspected.databaseDigest })
  return openDesignJournal({ root: options.root, ...scope })
}
