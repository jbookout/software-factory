// Prove's criterion evidence contract (Design Manager slice 4). It reads bound
// artifact bytes through a caller-supplied store and reports a gate verdict;
// it grants no merge, deployment or final acceptance authority.
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import Ajv2020 from 'ajv/dist/2020.js'
import { createBoundReader } from './evidence.mjs'
import { canonicalDigest, deepFreeze } from './canonical.mjs'
import { hmacSignature, hmacSignatureMatches } from './hmac-signature.mjs'

const schema = JSON.parse(readFileSync(new URL('../schemas/design-verify.schema.json', import.meta.url)))
const ajv = new Ajv2020({ strict: true, allErrors: true }).addSchema(schema)
const validator = name => ajv.getSchema(`${schema.$id}#/$defs/${name}`)
const validateIndex = validator('featureIndex')
const validateFeature = validator('feature')
const validateCriteria = validator('criteria')
const validateTarget = validator('target')
const validateCheck = validator('check')
const validateReview = validator('review')

/** The only engine whose runs count as e2e acceptance evidence (plan: package pin). */
export const ACCEPTANCE_ENGINE = 'e2e@0.15.1'
const MAX_FAILED_REPAIR_ROUNDS = 2

const schemaErrors = (validate, label) => (validate.errors ?? [])
  .map(error => `${label}${error.instancePath} ${error.message}`)
function assertReviewKey(key) {
  if (typeof key !== 'string' || Buffer.byteLength(key) < 32) throw new Error('review key must be at least 32 bytes')
}

/** Product-owned VERIFY feature map: an index plus one file per user-facing feature. */
export function validateFeatureMap({ index, features } = {}) {
  if (!validateIndex(index)) return schemaErrors(validateIndex, 'index')
  if (!Array.isArray(features)) return ['features must be an array']
  const errors = []
  const listed = index.features.map(feature => feature.id)
  for (const id of listed.filter((id, i) => listed.indexOf(id) !== i)) errors.push(`duplicate index entry ${id}`)
  for (const feature of features) {
    if (!validateFeature(feature)) { errors.push(...schemaErrors(validateFeature, `feature ${feature?.id}`)); continue }
    if (!listed.includes(feature.id)) errors.push(`${feature.id} is not listed in the index`)
    const entries = feature.entryPoints.map(entry => entry.id)
    for (const id of entries.filter((id, i) => entries.indexOf(id) !== i)) errors.push(`duplicate entry point ${id} in ${feature.id}`)
  }
  for (const id of listed) {
    const count = features.filter(feature => feature?.id === id).length
    if (count === 0) errors.push(`${id} has no feature file`)
    if (count > 1) errors.push(`${id} has ${count} feature files`)
  }
  return errors
}

/** The product's map is part of the build: a target names the map its entry points come from. */
export function verifyFeatureMapDigest(featureMap) {
  const errors = validateFeatureMap(featureMap)
  if (errors.length) throw new Error(`invalid feature map: ${errors.join('; ')}`)
  return canonicalDigest(featureMap)
}

const manifestContent = ({ projectId, version, contract, criteria, traps }) => ({ projectId, version, contract, criteria, traps })

/**
 * Freeze each criterion before execution: stable ID, expectation, blocking status,
 * evidence kind, platforms, every entry point of its feature and a planted defect
 * with its expected violation. The digest binds the frozen manifest.
 */
export function freezeVerifyCriteria({ featureMap, ...input }) {
  const featureMapDigest = verifyFeatureMapDigest(featureMap)
  if (!validateCriteria(input)) throw new Error(`malformed criteria: ${schemaErrors(validateCriteria, 'criteria').join('; ')}`)
  const ids = input.criteria.map(criterion => criterion.id)
  for (const id of ids) if (ids.indexOf(id) !== ids.lastIndexOf(id)) throw new Error(`duplicate criterion ${id}`)
  for (const criterion of input.criteria) {
    const feature = featureMap.features.find(item => item.id === criterion.featureId)
    if (!feature) throw new Error(`criterion ${criterion.id} names unknown feature ${criterion.featureId}`)
    const mapped = feature.entryPoints.map(entry => entry.id)
    for (const entry of criterion.entryPoints) if (!mapped.includes(entry))
      throw new Error(`criterion ${criterion.id} names unmapped entry point ${entry}`)
    // A convenient entry point cannot stand for the others.
    for (const entry of mapped) if (!criterion.entryPoints.includes(entry))
      throw new Error(`criterion ${criterion.id} omits feature entry point ${entry}`)
  }
  const trapIds = input.traps.map(trap => trap.id)
  for (const trap of input.traps) {
    if (trapIds.indexOf(trap.id) !== trapIds.lastIndexOf(trap.id)) throw new Error(`duplicate trap ${trap.id}`)
    if (!ids.includes(trap.criterionId)) throw new Error(`trap ${trap.id} names unknown criterion ${trap.criterionId}`)
  }
  const content = { ...structuredClone(manifestContent(input)), featureMapDigest }
  return deepFreeze({ schema: 'design-verify-criteria.v1', ...content, digest: canonicalDigest(content) })
}

/** Full candidate identity: a commit alone does not distinguish two builds. */
export function verifyTargetDigest(target) {
  if (!validateTarget(target)) throw new Error(`malformed verification target: ${schemaErrors(validateTarget, 'target').join('; ')}`)
  return canonicalDigest(target)
}

/** Signed by the core that launched the reviewer seat; a supplied string is not identity. */
export function signReviewReceipt(payload, key) {
  assertReviewKey(key)
  if (!validateReview(payload)) throw new Error(`malformed review receipt: ${schemaErrors(validateReview, 'review').join('; ')}`)
  return { payload: structuredClone(payload), signature: hmacSignature(payload, key) }
}

/**
 * Two failed repair rounds stop automatic repair. The manager then escalates
 * one concise human choice instead of looping.
 */
export function planRepair({ failedRounds, failing } = {}) {
  if (!Number.isInteger(failedRounds) || failedRounds < 0 || !Array.isArray(failing) ||
      failing.some(id => typeof id !== 'string')) throw new Error('invalid repair history')
  if (!failing.length) return { action: 'done' }
  if (failedRounds < MAX_FAILED_REPAIR_ROUNDS) return { action: 'repair', round: failedRounds + 1 }
  return { action: 'escalate', diagnosis: { failedRounds, failing: [...failing] },
    question: `Automatic repair failed ${failedRounds} rounds for ${failing.join(', ')}; ` +
      'repair with a changed approach, narrow the version scope, or stop?' }
}

function reviewVerdict({ review, reviewKey, target, targetDigest, manifest, recordDigests }) {
  if (review === null || review === undefined) return { status: 'missing', failed: [], blocked: ['no independent review receipt'] }
  assertReviewKey(reviewKey)
  const payload = review?.payload
  if (!validateReview(payload) || !hmacSignatureMatches(payload, review.signature, reviewKey))
    return { status: 'rejected', failed: ['review signature does not authenticate the receipt'], blocked: [] }
  const failed = []
  const makerSessions = target.makers.sessions
  if (target.makers.ids.includes(payload.reviewerId)) failed.push('maker approves its own work')
  if (makerSessions.includes(payload.sessionId) ||
      payload.freshContext.inheritedSessions.some(session => makerSessions.includes(session)))
    failed.push('review lacks a fresh context: it shares a maker session')
  if (payload.freshContext.receivedMakerScores) failed.push('reviewer received maker scores')
  if (payload.targetDigest !== targetDigest) failed.push('review is bound to another target')
  if (payload.manifestDigest !== manifest.digest) failed.push('review is bound to another manifest')
  const unread = recordDigests.filter(digest => !payload.recordsRead.includes(digest))
  if (unread.length) failed.push(`reviewer did not read ${unread.length} required record(s)`)
  if (payload.verdict === 'fail') failed.push('independent reviewer failed the candidate')
  return { status: failed.length ? 'rejected' : 'authenticated', failed, blocked: [] }
}

async function criterionVerdict({ criterion, rows, traps, target, read }) {
  const failed = []
  const blocked = []
  const pending = []
  const label = row => `${criterion.id}/${row.binding.platform}/${row.entryPoint}`

  async function check(row) {
    const { method } = row
    if (criterion.evidence === 'e2e') {
      if (method === 'unit' || method === 'component')
        failed.push(`${label(row)}: unit/component tests cannot accept a user-facing criterion`)
      else if (method === 'driver') failed.push(`${label(row)}: a dev-loop driver session is not acceptance evidence`)
      else if (method !== 'e2e') failed.push(`${label(row)}: ${criterion.id} requires e2e evidence; got ${method}`)
      else if (row.binding.engine !== ACCEPTANCE_ENGINE)
        failed.push(`${label(row)}: engine ${row.binding.engine} is not the qualified acceptance engine ${ACCEPTANCE_ENGINE}`)
    } else if (method !== criterion.evidence) {
      failed.push(`${label(row)}: ${criterion.id} requires ${criterion.evidence} evidence; got ${method}`)
    }
    if (row.expected !== criterion.expectation) failed.push(`${label(row)}: expectation differs from the frozen criterion`)
    if (!criterion.platforms.includes(row.binding.platform)) failed.push(`${label(row)}: platform not declared for ${criterion.id}`)
    for (const field of ['projectId', 'version']) if (row.binding[field] !== target[field])
      failed.push(`${label(row)}: bound to another build: ${field}`)
    if (row.binding.contractRevision !== target.contract.revision) failed.push(`${label(row)}: bound to another build: contractRevision`)
    if (row.binding.contractDigest !== target.contract.digest) failed.push(`${label(row)}: bound to another build: contractDigest`)
    const persistence = row.persistence ? [row.persistence.writtenValue, row.persistence.independentReadback] : []
    for (const artifact of [row.oracle, ...row.artifacts, ...persistence]) {
      const result = await read(artifact)
      if (result.failed) failed.push(`${label(row)}: ${result.failed}`)
      if (result.blocked) blocked.push(`${label(row)}: ${result.blocked}`)
    }
  }

  for (const row of rows) await check(row)
  const candidates = rows.filter(row => row.role === 'candidate')
  const oracles = [...new Set(candidates.map(row => row.oracle.digest))]
  if (oracles.length > 1) failed.push(`${criterion.id}: candidate rows use different oracles`)
  // With no candidate yet there is no oracle to compare; the missing rows are already pending.
  const differentOracle = row => oracles.length > 0 && row.oracle.digest !== oracles[0]
  for (const row of candidates) {
    const platform = target.platforms[row.binding.platform]
    for (const field of ['sourceCommit', 'buildDigest', 'buildConfigDigest']) if (row.binding[field] !== target[field])
      failed.push(`${label(row)}: bound to another build: ${field}`)
    // Each evidence kind runs on its own declared engine; a manual check never borrows the e2e engine.
    if (row.binding.engine !== platform?.engines[criterion.evidence]) failed.push(`${label(row)}: bound to another build: engine`)
    if (row.binding.targetId !== platform?.targetId) failed.push(`${label(row)}: bound to another build: targetId`)
    if (target.fixtures[row.fixture.id] !== row.fixture.digest) failed.push(`${label(row)}: bound to another fixture: ${row.fixture.id}`)
  }
  for (const platform of criterion.platforms) {
    for (const entryPoint of criterion.entryPoints) {
      const matching = candidates.filter(row => row.binding.platform === platform && row.entryPoint === entryPoint)
      if (!matching.length) pending.push(`missing required row ${criterion.id}/${platform}/${entryPoint}`)
      for (const row of matching) {
        if (row.entryPointStatus === 'skipped') failed.push(`${label(row)}: skipped entry point ${entryPoint} is never verified`)
        else if (row.entryPointStatus === 'blocked' || row.outcome === 'blocked') blocked.push(`${label(row)}: blocked row cannot pass`)
        else if (row.outcome === 'failed') failed.push(`${label(row)}: failed: ${row.observed}`)
        if (criterion.storedValue && !row.persistence) failed.push(`${label(row)}: stored-value claim requires persistence proof`)
        if (row.persistence && (row.persistence.writtenValue.ref === row.persistence.independentReadback.ref ||
            row.persistence.writtenValue.digest === row.persistence.independentReadback.digest))
          failed.push(`${label(row)}: stored-value readback is not an independent read`)
      }
    }
    // Each check must catch its frozen planted defect with the same oracle, then pass the repair.
    for (const [role, fixture] of [['broken', criterion.defect.broken], ['repaired', criterion.defect.repaired]]) {
      const runs = rows.filter(row => row.role === role && row.binding.platform === platform)
      if (!runs.some(row => isDeepStrictEqual(row.fixture, fixture)))
        pending.push(`no ${role} fixture run for ${criterion.id}/${platform}`)
      for (const row of runs) {
        if (!isDeepStrictEqual(row.fixture, fixture)) failed.push(`${label(row)}: ${role} run used an unfrozen fixture`)
        if (differentOracle(row)) failed.push(`${label(row)}: ${role} run used a different oracle`)
        if (row.outcome === 'blocked' || row.entryPointStatus !== 'exercised') blocked.push(`${label(row)}: ${role} run did not complete`)
        else if (role === 'broken' && row.outcome === 'passed')
          failed.push(`${criterion.id}: check passed its broken fixture and is disqualified`)
        else if (role === 'broken' && row.finding !== criterion.defect.expectedViolation)
          failed.push(`${label(row)}: finding does not match the frozen expected violation`)
        else if (role === 'repaired' && row.outcome !== 'passed') failed.push(`${label(row)}: repaired fixture still fails`)
      }
    }
  }
  for (const trap of traps) {
    const runs = rows.filter(row => row.role === 'trap' && row.trapId === trap.id)
    if (!runs.length) pending.push(`trap ${trap.id} has no run`)
    for (const row of runs) {
      if (!isDeepStrictEqual(row.fixture, trap.fixture)) failed.push(`trap ${trap.id} ran an unfrozen fixture`)
      if (differentOracle(row)) failed.push(`trap ${trap.id} used a different oracle`)
      if (row.outcome === 'blocked') blocked.push(`trap ${trap.id} run did not complete`)
      else if (row.outcome === 'failed') failed.push(`trap ${trap.id} flagged (false positive): ${row.observed}`)
    }
  }
  const verdict = failed.length ? 'fail' : blocked.length ? 'blocked' : pending.length ? 'pending' : 'pass'
  return { id: criterion.id, blocking: criterion.blocking, verdict, reasons: [...failed, ...blocked, ...pending] }
}

/**
 * Compares every required criterion record with the candidate's full build
 * identity and contract revision, reading each bound artifact's bytes. Evidence
 * for build A never approves build B. Failed or blocked rows are kept, a missing
 * row stays pending and no score or reviewer pass overrides a failed blocking
 * criterion. Digests bind bytes, not truth; live independence of the reviewer
 * seat comes from the core's signing key, not from supplied IDs.
 */
export async function evaluateVerification(input) {
  // Judge snapshots: the injected reader yields control, so a live input could change mid-evaluation.
  const { manifest, featureMap, target, records, review } = structuredClone({ manifest: input.manifest,
    featureMap: input.featureMap, target: input.target, records: input.records, review: input.review })
  const { reviewKey, readArtifact, limits } = input
  const failed = []
  const blocked = []
  const result = (criteria, reviewed = { status: 'missing', failed: [], blocked: [] }, targetDigest = null) => {
    const criteriaFailed = criteria.some(c => c.blocking && c.verdict === 'fail')
    const gate = failed.length || criteriaFailed || reviewed.failed.length ? 'fail'
      : blocked.length || reviewed.blocked.length || criteria.some(c => c.verdict === 'blocked') ? 'blocked'
        : criteria.some(c => c.verdict === 'pending') ? 'pending' : 'pass'
    const review = { status: reviewed.status, reasons: [...reviewed.failed, ...reviewed.blocked] }
    return { gate, targetDigest, criteria,
      review, reasons: [...failed, ...blocked, ...criteria.flatMap(c => c.reasons), ...review.reasons] }
  }
  let targetDigest
  try { targetDigest = verifyTargetDigest(target) } catch (error) { failed.push(error.message); return result([]) }
  try {
    if (verifyFeatureMapDigest(featureMap) !== target.featureMapDigest) {
      failed.push("feature map is not the target build's map")
      return result([], undefined, targetDigest)
    }
    const frozen = freezeVerifyCriteria({ featureMap, ...manifestContent(manifest ?? {}) })
    if (manifest.featureMapDigest !== target.featureMapDigest) failed.push('manifest was frozen against another feature map')
    if (frozen.digest !== manifest.digest) failed.push('manifest digest does not match its frozen content')
  } catch (error) { failed.push(`manifest: ${error.message}`); return result([], undefined, targetDigest) }
  if (manifest.projectId !== target.projectId || manifest.version !== target.version ||
      !isDeepStrictEqual(manifest.contract, target.contract)) failed.push('manifest is for another project version or contract')
  if (typeof readArtifact !== 'function' || !Array.isArray(records)) {
    blocked.push('no artifact reader or record list is configured')
    return result([], undefined, targetDigest)
  }

  const read = createBoundReader({ readArtifact, limits })
  const byCriterion = new Map(manifest.criteria.map(criterion => [criterion.id, []]))
  const malformed = new Map()
  const recordDigests = []
  for (const record of records) {
    const bytes = await read(record)
    if (bytes.failed) { failed.push(bytes.failed); continue }
    if (bytes.blocked) { blocked.push(bytes.blocked); continue }
    recordDigests.push(bytes.digest)
    let row
    try { row = JSON.parse(bytes.bytes.toString('utf8')) } catch { row = null }
    const owner = byCriterion.has(row?.criterionId) ? row.criterionId : null
    if (!validateCheck(row)) {
      const reason = `malformed check record ${record.ref}: ${schemaErrors(validateCheck, 'check').join('; ')}`
      if (owner) malformed.set(owner, [...(malformed.get(owner) ?? []), reason])
      else failed.push(reason)
      continue
    }
    if (!owner) { failed.push(`check record ${record.ref} names unknown criterion ${row.criterionId}`); continue }
    byCriterion.get(owner).push(row)
  }

  const criteria = []
  for (const criterion of manifest.criteria) {
    const verdict = await criterionVerdict({ criterion, rows: byCriterion.get(criterion.id),
      traps: manifest.traps.filter(trap => trap.criterionId === criterion.id), target, read })
    const extra = malformed.get(criterion.id) ?? []
    criteria.push(extra.length ? { ...verdict, verdict: 'fail', reasons: [...extra, ...verdict.reasons] } : verdict)
  }
  return result(criteria, reviewVerdict({ review, reviewKey, target, targetDigest, manifest, recordDigests }), targetDigest)
}
