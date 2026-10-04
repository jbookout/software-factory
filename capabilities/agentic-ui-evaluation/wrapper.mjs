// Factory wrapper around TesterArmy e2e (Design Manager slice 4). The product
// owns e2e, its lockfile, config and fixtures; this wrapper only fixes the
// invocation environment, gates attended auth and judges normalized receipts.
// It is a non-blocking pilot: product-local deterministic checks stay authoritative.
import { createBoundReader } from '../../src/evidence.mjs'
import { ACCEPTANCE_ENGINE } from '../../src/design-verify.mjs'

// The gate owns the pinned acceptance engine; the wrapper invokes exactly that pin.
const [pinnedPackage, pinnedVersion] = ACCEPTANCE_ENGINE.split('@')
export const E2E_PIN = Object.freeze({ package: pinnedPackage, version: pinnedVersion, license: 'Apache-2.0',
  sourceRevision: '8d38206f460415b70706b45acb820bb0e24832ae' })
export const E2E_MODES = Object.freeze(['run', 'explore', 'bug-bash', 'mcp', 'replay'])
const LOGIN_ACTION = 'Sign in to e2e with ChatGPT (attended)'
const EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000
const CREDENTIAL_FIELDS = /token|secret|password|cookie|oauth/i
// e2e agent critique never becomes user evidence; accessibility stays heuristic.
const SIMULATED = 'simulated-critique'

/** Telemetry is disabled on every invocation, whatever the caller's environment says. */
export function e2eEnvironment(env = {}, mode = 'run') {
  if (!E2E_MODES.includes(mode)) throw new Error(`unknown e2e mode ${mode}`)
  return { ...env, E2E_TELEMETRY_DISABLED: '1' }
}

/**
 * Model-backed e2e runs are attended only. Health carries expiry and refresh
 * status, never token contents; any doubt blocks with one login action.
 */
export function attendedEvaluationStatus({ attended, health, now = Date.now(), warningMs = EXPIRY_WARNING_MS }) {
  if (health && Object.keys(health).some(key => CREDENTIAL_FIELDS.test(key)))
    throw new Error('credential contents must not reach the factory')
  const blocked = reason => ({ status: 'blocked', reason, action: LOGIN_ACTION })
  if (attended !== true) return blocked('model-backed e2e runs are attended only; waiting at the attended-evaluation checkpoint')
  if (health?.status === 'LOGIN_REQUIRED') return blocked('e2e reported LOGIN_REQUIRED')
  if (health?.status !== 'ok') return blocked('e2e credential health is unknown')
  const expiresAt = Date.parse(health.expiresAt ?? '')
  if (!Number.isFinite(expiresAt)) return blocked('credential health has missing expiry')
  if (health.refreshCheck !== 'passed') return blocked('credential refresh health check failed')
  if (expiresAt - now <= warningMs) return blocked(`credential expires at ${health.expiresAt}`)
  return { status: 'ready', reason: null, action: null }
}

const sameBuild = (binding, candidate) => binding?.sourceCommit === candidate.sourceCommit &&
  binding?.buildDigest === candidate.buildDigest

/**
 * A finding counts only when its repro fails with an assertion on the exact
 * candidate. Stories, screenshots and blocked runs are discarded but retained
 * for audit; an explained non-bug is rejected with its expectation and observation.
 */
export function triageFindings({ candidate, charters = [], findings }) {
  const namespaces = charters.map(charter => charter.stateNamespace)
  const blocked = new Set(namespaces).size !== namespaces.length ? 'concurrent charters share mutable state' : null
  const confirmed = []
  const rejected = []
  const discarded = []
  for (const finding of findings) {
    const labelled = reason => ({ ...structuredClone(finding), evidenceStrength: SIMULATED, ...(reason ? { reason } : {}) })
    const repro = finding.repro
    if (finding.explanation) rejected.push(labelled(`explained non-bug: ${finding.explanation.expectation} / ${finding.explanation.observation}`))
    else if (!repro) discarded.push(labelled('no failing repro'))
    else if (repro.outcome === 'blocked') discarded.push(labelled('blocked run (auth/startup/navigation) is not a confirmed bug'))
    else if (!sameBuild(repro.binding, candidate)) discarded.push(labelled('repro is not on the exact candidate'))
    else if (repro.outcome !== 'failed' || !repro.assertion) discarded.push(labelled('repro did not fail with an assertion'))
    else confirmed.push(labelled(null))
  }
  return { blocked, confirmed, rejected, discarded }
}

const sameTest = (a, b) => a?.test?.ref === b?.test?.ref && a?.test?.digest === b?.test?.digest

/**
 * Qualification on a small app with a frozen defect manifest and traps. Pass
 * only if every planted defect is caught with a failing repro, no trap is
 * flagged, each repro passes on the separately repaired build, a deterministic
 * replay makes zero provider calls with the same outcome, and archived
 * evidence survives cleanup. Qualified still means non-blocking pilot.
 */
export async function qualifyAgenticEvaluation({ manifest, broken, repaired, replay, archive }) {
  const reasons = []
  const triage = triageFindings(broken)
  if (triage.blocked) reasons.push(triage.blocked)
  const repros = new Map()
  for (const defect of manifest.defects) {
    const caught = triage.confirmed.find(finding => finding.repro.assertion === defect.assertion && finding.repro.route === defect.route)
    if (!caught) { reasons.push(`planted defect ${defect.id} missed`); continue }
    repros.set(defect.id, caught.repro)
  }
  for (const trap of manifest.traps) {
    if (triage.confirmed.some(finding => finding.repro.route === trap.route)) reasons.push(`trap ${trap.id} flagged`)
  }
  if (sameBuild(repaired.candidate, broken.candidate)) reasons.push('repaired build must differ from the broken build')
  for (const [id, repro] of repros) {
    if (!repaired.reruns.some(rerun => sameTest(rerun, repro) && rerun.outcome === 'passed' && sameBuild(rerun.binding, repaired.candidate)))
      reasons.push(`repro for ${id} not rerun passing on the repaired build`)
    const replayed = replay.reruns.find(rerun => sameTest(rerun, repro))
    if (!replayed || !sameBuild(replayed.binding, broken.candidate)) reasons.push(`repro for ${id} not replayed on the broken build`)
    else if (replayed.assertionKind !== 'deterministic') reasons.push(`replay of ${id} must use deterministic assertions`)
    else if (replayed.outcome !== repro.outcome) reasons.push(`replay changed the outcome of ${id}`)
  }
  // Count provider invocations, not cached-step labels; a missing count is not zero.
  if (replay.providerInvocations !== 0) reasons.push(`model call during replay: ${replay.providerInvocations ?? 'uncounted'}`)
  const read = createBoundReader({ readArtifact: archive.readArtifact, limits: archive.limits })
  for (const artifact of archive.refs) {
    const result = await read(artifact)
    if (!result.bytes) reasons.push(`lost evidence: ${result.failed ?? result.blocked}`)
  }
  return { status: reasons.length ? 'disqualified' : 'qualified', reasons, pilot: 'non-blocking',
    evidenceStrength: SIMULATED, confirmed: triage.confirmed, rejected: triage.rejected, discarded: triage.discarded }
}
