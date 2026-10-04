#!/usr/bin/env node
// Offline, caller-supplied evidence assessment, never runner dispatch or gate authority.
// See test/ci-runner-benchmark.test.mjs for a complete synthetic input bundle.
import { openSync, closeSync, fstatSync, readSync, writeFileSync, constants } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseDocument, isMap, isScalar } from 'yaml'
import { canonicalDigest, canonicalJson } from '../src/canonical.mjs'
import { classifyChecks, validRequiredChecks } from '../src/pr-readiness.mjs'

const REPOS = ['jbookout/carr-system', 'jbookout/doctorcre-app', 'jbookout/software-factory']
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/
const PARITY = ['pg', 'browser', 'runtime', 'network', 'artifact', 'checkout', 'sudo', 'loopback']
const HARDWARE = ['cpuCount', 'memoryBytes', 'peakMemoryBytes', 'cpuDigest', 'osDigest', 'filesystemDigest', 'toolchainDigest']
const same = (a, b) => canonicalJson(a) === canonicalJson(b)
const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0
const positiveId = x => Number.isSafeInteger(x) && x > 0
const timestamp = x => typeof x === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(x) ? Date.parse(x) : NaN
const fresh = (x, now) => Number.isFinite(timestamp(x)) && timestamp(x) <= now && now - timestamp(x) <= 7 * 86400000
function receipt(state, reason, extra = {}) {
  return { schema: 'ci-runner-benchmark/v1', mode: 'shadow', gateAuthority: false,
    evidenceTrust: 'caller-supplied; authenticate artifacts independently before any trial or adoption',
    state, reason, nextAction: { unknown: 'collect-missing-evidence', declined: 'retain-original-selector-and-decline-provider',
      rejected: 'retain-original-selector-and-investigate-trial', 'qualified-shadow': 'orchestrator-verify-evidence-before-separate-rollout' }[state], ...extra }
}
function stop(state, reason) { throw { benchmarkState: state, reason } }
function need(ok, reason, state = 'unknown') { if (!ok) stop(state, reason) }
function preflight(x, now) {
  need(Array.isArray(x.owners) && x.owners.length === REPOS.length, 'owner-evidence')
  for (const repo of REPOS) {
    const found = x.owners.filter(o => o?.repo === repo)
    need(found.length === 1 && ['User', 'Organization'].includes(found[0].type) && fresh(found[0].observed_at, now) && DIGEST.test(found[0].evidenceDigest), 'owner-evidence')
  }
  const p = x.provider
  need(p && fresh(p.observed_at, now) && DIGEST.test(p.evidenceDigest) && Array.isArray(p.supportedOwnerTypes) &&
    p.supportedOwnerTypes.length > 0 && p.supportedOwnerTypes.every(t => ['User', 'Organization'].includes(t)), 'provider-evidence')
  need(x.owners.every(o => p.supportedOwnerTypes.includes(o.type)), 'owner-ineligible', 'declined')
  need(Array.isArray(p.labels), 'label-evidence')
  need(p.labels.includes(x.candidateSelector), 'label-unavailable', 'declined')
  need(DIGEST.test(p.pricingDigest) && number(p.newSpendUsd) && number(p.maxTrialUsd), 'pricing-evidence')
  need(p.newSpendUsd === 0, 'new-spend', 'declined')
  const install = p.install
  need(install && Array.isArray(install.repositories) && DIGEST.test(install.permissionsDigest) && DIGEST.test(install.acceptedPermissionsDigest) && typeof install.productionCredentials === 'boolean', 'installation-evidence')
  need(same(install.repositories, [x.repo]) && install.permissionsDigest === install.acceptedPermissionsDigest && !install.productionCredentials, 'installation-scope', 'declined')
  const probe = p.probe
  need(probe && DIGEST.test(probe.evidenceDigest) && typeof probe.passed === 'boolean', 'probe-evidence')
  need(probe.repo === x.repo && probe.label === x.candidateSelector && probe.passed, 'probe-refused', 'declined')
}
function workflowParity(x) {
  need(typeof x.originalSelector === 'string' && /^[a-zA-Z0-9_-]+$/.test(x.originalSelector) &&
    typeof x.candidateSelector === 'string' && /^[a-zA-Z0-9_-]+$/.test(x.candidateSelector) && x.originalSelector !== x.candidateSelector, 'selectors')
  need(typeof x.originalWorkflow === 'string' && typeof x.candidateWorkflow === 'string', 'workflow-evidence')
  const before = x.originalWorkflow.split('\n'), after = x.candidateWorkflow.split('\n')
  need(before.length === after.length, 'workload-changed', 'rejected')
  const changed = before.map((line, i) => line === after[i] ? -1 : i).filter(i => i !== -1)
  need(changed.length === 1, 'workload-changed', 'rejected')
  const i = changed[0], match = before[i].match(/^( +)runs-on: ([a-zA-Z0-9_-]+)$/)
  need(match && match[2] === x.originalSelector && after[i] === `${match[1]}runs-on: ${x.candidateSelector}`, 'workload-changed', 'rejected')
  const original = parseDocument(x.originalWorkflow), candidate = parseDocument(x.candidateWorkflow)
  need(!original.errors.length && !candidate.errors.length, 'workflow-syntax')
  const jobs = original.get('jobs', true)
  need(isMap(jobs), 'workflow-jobs')
  const lineStart = before.slice(0, i).reduce((total, line) => total + line.length + 1, 0)
  const selected = jobs.items.filter(job => {
    const node = isScalar(job.key) ? original.getIn(['jobs', job.key.value, 'runs-on'], true) : null
    return isScalar(node) && node.value === x.originalSelector && node.range?.[0] === lineStart + before[i].indexOf(x.originalSelector)
  })
  need(selected.length === 1, 'not-a-job-selector', 'rejected')
  const afterNode = candidate.getIn(['jobs', selected[0].key.value, 'runs-on'], true)
  need(isScalar(afterNode) && afterNode.value === x.candidateSelector, 'not-a-job-selector', 'rejected')
  // Only a directly defined simple scalar selector qualifies. Anchors, arrays,
  // expressions and shell text require a separate reviewed experiment shape.
  return { baseline: canonicalDigest(x.originalWorkflow), candidate: canonicalDigest(x.candidateWorkflow), workload: canonicalDigest(x.originalWorkflow) }
}
function runEvidence(r, required, expectedWorkflow, expectedSelector, registeredAt, observedAt, ids) {
  need(r && positiveId(r.id) && !ids.has(r.id), 'duplicate-or-invalid-run', 'rejected'); ids.add(r.id)
  need(r.run_attempt === 1, 'retry-selection', 'rejected')
  need(SHA.test(r.head_sha) && SHA.test(r.tree_sha), 'source-evidence')
  for (const key of ['inputDigest', 'workflowDigest', 'workloadDigest', 'environmentDigest', 'loadDigest']) need(DIGEST.test(r[key]), 'input-binding')
  need(r.workflowDigest === expectedWorkflow && r.selector === expectedSelector, 'workflow-binding', 'rejected')
  const queued = timestamp(r.created_at), started = timestamp(r.started_at)
  need(Number.isFinite(queued) && Number.isFinite(started) && started >= queued, 'timing-evidence')
  need(registeredAt <= queued, 'late-registration', 'rejected')
  need(Array.isArray(r.checkRuns) && Array.isArray(r.statuses) && r.statuses.length === 0, 'check-evidence')
  const checks = classifyChecks({ head: r.head_sha, observedHead: r.head_sha, requiredChecks: required, checkRuns: r.checkRuns, statuses: r.statuses })
  need(['success', 'failure'].includes(checks.state) && !checks.missing?.length, 'required-checks-incomplete')
  need(r.checkRuns.length === required.length, 'check-inventory', 'rejected')
  const names = new Set(), inventory = [], ends = []
  for (const check of r.checkRuns) {
    need(check.status === 'completed', 'check-pending')
    need(['success', 'failure'].includes(check.conclusion), 'check-verdict', 'rejected')
    const key = canonicalJson([check.name, check.app?.id])
    need(check.head_sha === r.head_sha && !names.has(key) && required.some(c => c.name === check.name && c.appId === check.app?.id), 'check-inventory', 'rejected')
    names.add(key); inventory.push([key, check.conclusion])
    const end = timestamp(check.completed_at)
    need(Number.isFinite(end) && end >= started && end <= observedAt, 'check-timestamp'); ends.push(end)
  }
  need(Array.isArray(r.tests) && r.tests.length > 0 && r.tests.every(t => DIGEST.test(t?.id) && ['success', 'failure'].includes(t.verdict)) && new Set(r.tests.map(t => t.id)).size === r.tests.length, 'test-inventory')
  need(['cold', 'warm'].includes(r.cacheState), 'cache-evidence')
  for (const key of PARITY) {
    need(r.parity?.[key] && DIGEST.test(r.parity[key].digest), 'environment-evidence')
    need(r.parity[key].status === 'pass', 'environment-failure', 'rejected')
  }
  const h = r.hardware
  need(h && positiveId(h.cpuCount) && number(h.memoryBytes) && h.memoryBytes > 0 && number(h.peakMemoryBytes) && h.peakMemoryBytes <= h.memoryBytes &&
    ['cpuDigest', 'osDigest', 'filesystemDigest', 'toolchainDigest'].every(k => DIGEST.test(h[k])), 'hardware-evidence')
  need(r.phases && ['setupSeconds', 'testSeconds', 'buildSeconds'].every(k => number(r.phases[k])), 'phase-evidence')
  const verdict = Math.max(...ends), seconds = (verdict - queued) / 1000
  need(Object.values(r.phases).every(number) && Object.values(r.phases).reduce((a, b) => a + b, 0) <= (verdict - started) / 1000, 'phase-timing')
  need(r.charge && number(r.charge.usd) && number(r.charge.overheadUsd) && DIGEST.test(r.charge.evidenceDigest), 'cost-evidence')
  need(Number.isSafeInteger(r.providerFailures) && r.providerFailures >= 0, 'failure-evidence')
  need(r.providerFailures === 0, 'provider-failure', 'rejected')
  return { seconds, queueSeconds: (started - queued) / 1000, inventory: inventory.sort(),
    tests: r.tests.map(t => [t.id, t.verdict]).sort(), charge: r.charge.usd + r.charge.overheadUsd }
}
const distribution = values => {
  const s = [...values].sort((a, b) => a - b), n = s.length
  return { median: (s[Math.floor((n - 1) / 2)] + s[Math.floor(n / 2)]) / 2, p95: s[Math.ceil(.95 * n) - 1] }
}
function lifecycleDistribution(runs) {
  return Object.fromEntries(['queueToGreenSeconds', 'greenToReviewSeconds', 'mergeToLiveSeconds'].map(key => {
    const values = runs.map(r => r.lifecycle?.[key]).filter(number)
    return [key, { status: values.length === runs.length ? 'complete' : 'unknown', samples: values.length,
      missing: runs.length - values.length, ...(values.length ? distribution(values) : { median: null, p95: null }) }]
  }))
}

export function assessBenchmark(input, { now = new Date().toISOString() } = {}) {
  try {
    const x = input
    need(x?.schema === 'ci-runner-experiment/v1' && x.repo === 'jbookout/doctorcre-app' && Number.isFinite(timestamp(now)), 'experiment-evidence')
    preflight(x, timestamp(now))
    need(DIGEST.test(x.baselineDigest), 'lifecycle-baseline')
    const workflow = workflowParity(x)
    need(validRequiredChecks(x.requiredChecks) && x.requiredChecks.every(c => positiveId(c.appId)), 'required-contract')
    need(Array.isArray(x.plannedPairs) && x.plannedPairs.length === 10 && Array.isArray(x.pairs) && x.pairs.length === 10, 'ten-pairs-required')
    const registered = timestamp(x.registered_at); need(Number.isFinite(registered), 'registration-evidence')
    need(timestamp(x.provider.observed_at) <= registered && x.owners.every(o => timestamp(o.observed_at) <= registered), 'preflight-after-registration', 'rejected')
    const ids = new Set(), baseline = [], candidate = [], observations = []
    let cold = false, warm = false, passing = false, failing = false, baselineCost = 0, candidateCost = 0
    for (const [i, pair] of x.pairs.entries()) {
      const a = pair?.baseline, b = pair?.candidate, plan = x.plannedPairs[i]
      need(a && b && plan?.baseline === a.id && plan?.candidate === b.id, 'planned-run-binding', 'rejected')
      need(a.head_sha === b.head_sha && a.tree_sha === b.tree_sha, 'paired-source-parity', 'rejected')
      const left = runEvidence(a, x.requiredChecks, workflow.baseline, x.originalSelector, registered, timestamp(now), ids)
      const right = runEvidence(b, x.requiredChecks, workflow.candidate, x.candidateSelector, registered, timestamp(now), ids)
      for (const key of ['head_sha', 'tree_sha', 'inputDigest', 'workloadDigest', 'environmentDigest', 'cacheState', 'loadDigest', 'parity']) need(same(a[key], b[key]), 'paired-input-parity', 'rejected')
      need(a.workloadDigest === workflow.workload && b.workloadDigest === workflow.workload, 'workload-binding', 'rejected')
      need(a.head_sha === x.pairs[0].baseline.head_sha && a.tree_sha === x.pairs[0].baseline.tree_sha, 'immutable-tree', 'rejected')
      need(same(left.inventory, right.inventory) && same(left.tests, right.tests), 'verdict-parity', 'rejected')
      cold ||= a.cacheState === 'cold'; warm ||= a.cacheState === 'warm'
      passing ||= left.inventory.every(([, verdict]) => verdict === 'success')
      failing ||= left.inventory.some(([, verdict]) => verdict === 'failure')
      baseline.push(left.seconds); candidate.push(right.seconds); baselineCost += left.charge; candidateCost += right.charge
      // No raw names, paths, logs, URLs or provider errors enter the receipt.
      observations.push({ pair: i + 1, baselineSeconds: left.seconds, candidateSeconds: right.seconds,
        baselineQueueSeconds: left.queueSeconds, candidateQueueSeconds: right.queueSeconds,
        baselinePhases: Object.fromEntries(['setupSeconds', 'testSeconds', 'buildSeconds'].map(k => [k, a.phases[k]])),
        candidatePhases: Object.fromEntries(['setupSeconds', 'testSeconds', 'buildSeconds'].map(k => [k, b.phases[k]])),
        cold: a.cacheState === 'cold', knownFailure: left.inventory.some(([, v]) => v === 'failure'),
        baselineHardware: Object.fromEntries(HARDWARE.map(k => [k, a.hardware[k]])),
        candidateHardware: Object.fromEntries(HARDWARE.map(k => [k, b.hardware[k]])) })
    }
    need(cold && warm && passing && failing, 'representative-controls', 'rejected')
    need(number(baselineCost) && number(candidateCost), 'aggregate-cost-evidence')
    const before = distribution(baseline), after = distribution(candidate)
    need(before.median > 0, 'zero-baseline')
    const metrics = { pairs: 10, baseline: before, candidate: after, medianImprovement: (before.median - after.median) / before.median,
      baselineUsd: baselineCost, candidateUsd: candidateCost, observations,
      downstream: { baseline: lifecycleDistribution(x.pairs.map(p => p.baseline)),
        candidate: lifecycleDistribution(x.pairs.map(p => p.candidate)) } }
    const extra = { inputDigest: canonicalDigest(x), baselineDigest: x.baselineDigest, metrics }
    if (candidateCost > x.provider.maxTrialUsd) return receipt('rejected', 'cost-ceiling', extra)
    if (after.p95 > before.p95) return receipt('rejected', 'p95-regression', extra)
    if (after.median > before.median * .8) return receipt('rejected', 'median-below-proposed-bar', extra)
    return receipt('qualified-shadow', 'proposed-bar-met-not-measured-adoption-proof', extra)
  } catch (error) {
    return receipt(error?.benchmarkState ?? 'unknown', error?.benchmarkState ? error.reason : 'invalid-evidence')
  }
}

// Each bounded REST GET is independent; an unavailable owner never zero-fills
// or discards owners that did return. No provider installation or purchase API.
export async function observeOwners({ now = new Date().toISOString(), run = args => spawnSync('gh', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 }) } = {}) {
  const owners = []
  for (const repo of REPOS) {
    try {
      const result = await run(['api', '--method', 'GET', `repos/${repo}`])
      if (result.status !== 0 || result.error) throw Error()
      const data = JSON.parse(result.stdout)
      if (data.full_name !== repo || !['User', 'Organization'].includes(data.owner?.type)) throw Error()
      owners.push({ repo, type: data.owner.type, observed_at: now, evidenceDigest: canonicalDigest(data), state: 'observed' })
    } catch { owners.push({ repo, state: 'unknown' }) }
  }
  return { schema: 'ci-runner-owner-observation/v1', mode: 'shadow', gateAuthority: false,
    state: owners.every(o => o.state === 'observed') ? 'observed' : 'unknown', owners,
    nextAction: 'verify-current-provider-support-labels-scope-pricing-and-disposable-probe' }
}

async function main(args) {
  if (same(args, ['--help'])) {
    process.stdout.write('Shadow only. No dispatch, installation, workflow edit, purchase or gate authority.\n' +
      'node scripts/ci-runner-benchmark.mjs --observe-owners [--output NEW.json]\n' +
      'node scripts/ci-runner-benchmark.mjs --input BUNDLE.json [--output NEW.json] [--now ISO_TIMESTAMP]\n' +
      'Input: ci-runner-experiment/v1; complete synthetic contract in test/ci-runner-benchmark.test.mjs.\n' +
      'Bundle: fresh owner/provider/label/pricing/scope/probe observations, item-21 baseline digest,\n' +
      'two exact workflows differing in one scalar selector, producer-bound required checks, preregistered\n' +
      'ten first-attempt pairs on one source/tree with matched cold/warm input/cache/load/environment,\n' +
      'Actions timestamps/check artifacts, hashed test inventories, PG/browser/runtime/network/artifact\n' +
      'parity, hardware, full setup/test/build phases and observed rounded charges including overhead.\n' +
      'All inputs are caller-supplied evidence, not independently authenticated. Keep raw artifacts private.\n' +
      'Exit: 0 qualified-shadow/owners observed; 1 decline/rejection; 2 unknown. Retain original selector.\n')
    return
  }
  let result
  try {
    const options = {}
    for (let i = 0; i < args.length; i++) {
      const key = args[i]
      if (!['--input', '--output', '--now', '--observe-owners'].includes(key) || key in options) throw Error()
      options[key] = key === '--observe-owners' ? true : args[++i]
      if (!options[key] || (typeof options[key] === 'string' && options[key].startsWith('--'))) throw Error()
    }
    if (Boolean(options['--input']) === Boolean(options['--observe-owners'])) throw Error()
    const now = options['--now'] ?? new Date().toISOString()
    if (!Number.isFinite(timestamp(now))) throw Error()
    if (options['--observe-owners']) result = await observeOwners({ now })
    else {
      const fd = openSync(options['--input'], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let bytes
      try {
        const stat = fstatSync(fd), limit = 10 * 1024 * 1024
        if (!stat.isFile() || stat.size > limit) throw Error()
        const buffer = Buffer.alloc(limit + 1); let length = 0, count
        while ((count = readSync(fd, buffer, length, buffer.length - length)) > 0) { length += count; if (length > limit) throw Error() }
        bytes = buffer.subarray(0, length)
      } finally { closeSync(fd) }
      result = assessBenchmark(JSON.parse(bytes), { now })
    }
    if (options['--output']) writeFileSync(options['--output'], JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 })
  } catch { result = receipt('unknown', 'invalid-or-unreadable-input-or-output') }
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exitCode = ['qualified-shadow', 'observed'].includes(result.state) ? 0 : result.state === 'unknown' ? 2 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
