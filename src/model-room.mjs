import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { askJev } from "./jev-usage.mjs"
import { hmacSignature, hmacSignatureMatches, isHmacSignature } from "./hmac-signature.mjs"
import { canonicalDigest } from "./canonical.mjs"

const execFileAsync = promisify(execFile)

const JEV_MODEL = "jev-1.13.0"
const MAX_TASK_CHARS = 4000
const MAX_CONTRACT_CHARS = 12000
const MAX_BUILD_CONTRACTS = 8
const MAX_OPTIONAL_CONTEXT = 4
const VISIBILITY = ["hide", "short", "long", "full"]
export const MODEL_ROOM_EVIDENCE_SCHEMA = "doctorcre-build-evaluation-bundle.v1"

function evidencePayload(bundle) {
  return { schema: MODEL_ROOM_EVIDENCE_SCHEMA, control: bundle.control,
    observations: bundle.observations }
}

function assertEvidenceKey(key) {
  if (typeof key !== "string" || Buffer.byteLength(key) < 32)
    throw new Error("model room evaluation key must be at least 32 bytes")
}

function assertEvaluationContent({ control, observations }) {
  if (!control || control.task_class !== "doctorcre-build" ||
      control.mode !== "qualified_only" || !Number.isInteger(control.minimum_cases) ||
      control.minimum_cases < 3 || !Array.isArray(observations))
    throw new Error("invalid model room evaluation bundle")
}

/** Sign independently checked observations with the evaluator's runtime key. */
export function signEvaluationBundle({ control, observations }, key) {
  assertEvidenceKey(key)
  assertEvaluationContent({ control, observations })
  const payload = { schema: MODEL_ROOM_EVIDENCE_SCHEMA, control, observations }
  return { ...payload, signature: hmacSignature(payload, key) }
}

/** Authenticate one bundle and return identity-bound verifier callbacks. */
export function authenticateEvaluationBundle(bundle, key) {
  assertEvidenceKey(key)
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) ||
      Object.keys(bundle).sort().join(",") !== "control,observations,schema,signature" ||
      bundle.schema !== MODEL_ROOM_EVIDENCE_SCHEMA || !isHmacSignature(bundle.signature))
    throw new Error("invalid model room evaluation bundle")
  assertEvaluationContent(bundle)
  if (!hmacSignatureMatches(evidencePayload(bundle), bundle.signature, key))
    throw new Error("model room evaluation signature mismatch")
  const authenticated = new WeakSet(bundle.observations.filter(value => value && typeof value === "object"))
  const bundleDigest = digest(evidencePayload(bundle))
  return { observations: bundle.observations, minimumCases: bundle.control.minimum_cases,
    bundleDigest, verifyObservation: observation => authenticated.has(observation),
    verifyControl: decision => decision?.task_class === bundle.control.task_class &&
      bundle.control.mode === "qualified_only" && decision.checked_cases >= bundle.control.minimum_cases }
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

function bounded(value, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error("invalid model room input")
  return value
}

/** Read a bounded contract excerpt from an exact Git commit, not a prompt claim. */
export async function readPinnedContract({ root, sourceRevision, path, startLine, endLine }) {
  if (typeof root !== "string" || !root || !/^[0-9a-f]{40}$/.test(sourceRevision) ||
      typeof path !== "string" || !/^[A-Za-z0-9_./-]+$/.test(path) ||
      path.startsWith("/") || path.split("/").includes("..") ||
      !Number.isInteger(startLine) || !Number.isInteger(endLine) ||
      startLine < 1 || endLine < startLine || endLine - startLine > 200)
    throw new Error("invalid pinned contract reference")
  const { stdout: kind } = await execFileAsync("git", ["cat-file", "-t", sourceRevision], { cwd: root })
  if (kind.trim() !== "commit") throw new Error("contract revision is not a commit")
  const { stdout } = await execFileAsync("git", ["show", `${sourceRevision}:${path}`],
    { cwd: root, maxBuffer: 2_000_000 })
  const lines = stdout.split("\n")
  if (endLine > lines.length) throw new Error("contract line range missing")
  const excerpt = bounded(lines.slice(startLine - 1, endLine).join("\n"), MAX_CONTRACT_CHARS)
  return { source_revision: sourceRevision, path, content_digest:
    `sha256:${createHash("sha256").update(excerpt).digest("hex")}`, excerpt }
}

/** Keep source text in the build request, while receipts retain only its digest. */
export function createPinnedBuildContext(contracts) {
  if (!Array.isArray(contracts) || !contracts.length || contracts.length > MAX_BUILD_CONTRACTS)
    throw new Error("invalid pinned build context")
  const bound = contracts.map(contract => {
    if (!contract || !/^[0-9a-f]{40}$/.test(contract.source_revision) ||
        typeof contract.path !== "string" || !/^[A-Za-z0-9_./-]+$/.test(contract.path) ||
        contract.path.startsWith("/") || contract.path.split("/").includes("..") ||
        !/^sha256:[0-9a-f]{64}$/.test(contract.content_digest))
      throw new Error("invalid pinned build context")
    const excerpt = bounded(contract.excerpt, MAX_CONTRACT_CHARS)
    const contentDigest = `sha256:${createHash("sha256").update(excerpt).digest("hex")}`
    if (contract.content_digest !== contentDigest) throw new Error("pinned build context digest mismatch")
    return { source_revision: contract.source_revision, path: contract.path,
      content_digest: contract.content_digest, excerpt }
  })
  return { schema: "pinned-build-context.v1", digest: digest(bound), contracts: bound }
}

export function verifyPinnedBuildContext(context) {
  if (!context || context.schema !== "pinned-build-context.v1" ||
      typeof context.digest !== "string") return false
  try {
    return createPinnedBuildContext(context.contracts).digest === context.digest
  } catch {
    return false
  }
}

/** Paired steering trial, using pinned inputs and independently read/graded artifacts.
 * execute is a bounded Model Room adapter; judge belongs to the evaluator, not
 * the model. This emits a proposal and never edits a steering file.
 */
export async function replaySteeringRemoval(input) {
  const { createBoundReader } = await import('./evidence.mjs')
  const { context, path, line, boundary, tasks, route, repetitions = 2,
    execute, judge, evaluatorDigest, readArtifact, timeoutMs = 60_000, runId = randomUUID() } = input
  if (!verifyPinnedBuildContext(context) || !Array.isArray(tasks) || !tasks.length || tasks.length > 8 ||
      !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !/^[0-9a-f]{64}$/.test(evaluatorDigest ?? '') ||
      !['guidance', 'authority', 'credential', 'evidence_integrity'].includes(boundary) ||
      typeof execute !== 'function' || typeof judge !== 'function' || typeof readArtifact !== 'function')
    throw Error('invalid steering replay')
  validateRoute(route)
  bounded(runId, 100)
  bounded(line, 1000)
  const contracts = context.contracts.filter(c => c.path === path)
  if (contracts.length !== 1 || contracts[0].excerpt.split(line).length !== 2)
    throw Error('steering removal must match exactly once in one pinned file')
  const removed = createPinnedBuildContext(context.contracts.map(c => {
    if (c.path !== path) return c
    const excerpt = c.excerpt.replace(line, '')
    return { ...c, excerpt, content_digest: `sha256:${createHash('sha256').update(excerpt).digest('hex')}` }
  }))
  const taskIds = new Set()
  const snapshot = structuredClone({ context, removed, tasks, route })
  for (const task of snapshot.tasks) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(task.id)) throw Error('invalid recorded task id')
    bounded(task.role, 1000)
    bounded(task.evidenceContract, 4000)
    bounded(task.input, 12000)
    if (taskIds.has(task.id) || !Array.isArray(task.checks) || !task.checks.length ||
        task.checks.some(check => typeof check !== 'string' || !check.trim()))
      throw Error('invalid recorded task')
    taskIds.add(task.id)
    const source = await createBoundReader({ readArtifact })(task.recordedSource)
    if (!source.bytes) throw Error(`recorded source unavailable: ${task.id}`)
  }
  const experimentDigest = canonicalDigest({ ...snapshot, path, line, boundary, repetitions, timeoutMs, runId, evaluatorDigest })
  const report = { schema: 'steering-removal-replay.v1', experimentDigest,
    scope: 'bounded_model_relative', runId, evaluatorDigest, route: snapshot.route, path, line, boundary,
    baselineContextDigest: context.digest, removedContextDigest: removed.digest,
    pairs: [], failures: [], regressions: [], changes: [], decision: 'insufficient_evidence' }
  const validMetrics = m => m && typeof m.taskSuccess === 'boolean' &&
    typeof m.requiredSourceDiscovery === 'boolean' &&
    Number.isSafeInteger(m.falseClaims) && m.falseClaims >= 0 &&
    Number.isSafeInteger(m.ruleViolations) && m.ruleViolations >= 0
  trials: for (let repeat = 0; repeat < repetitions; repeat++) {
    for (const task of snapshot.tasks) {
      const pair = { taskId: task.id, repeat, baseline: null, removed: null }
      for (const arm of repeat % 2 ? ['removed', 'baseline'] : ['baseline', 'removed']) {
        const request = { trialId: `${experimentDigest}-${task.id}-${repeat}-${arm}`, arm,
          task, route: snapshot.route, context: arm === 'baseline' ? snapshot.context : snapshot.removed }
        request.digest = canonicalDigest(request)
        const controller = new AbortController()
        let timer
        const expired = new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(Error('trial deadline exceeded; observe before retry'))
        }, timeoutMs) })
        try {
          const artifact = structuredClone(await Promise.race([
            Promise.resolve().then(() => execute(structuredClone(request), { signal: controller.signal, timeoutMs })),
            expired
          ]))
          const evidence = await Promise.race([createBoundReader({ readArtifact })(artifact), expired])
          if (!evidence.bytes) throw Error('trial artifact unreadable or digest mismatch')
          const response = JSON.parse(evidence.bytes.toString('utf8'))
          if (response.requestDigest !== request.digest ||
              canonicalDigest(response.routeReadback) !== canonicalDigest(snapshot.route) ||
              typeof response.result !== 'string' || !response.result.trim())
            throw Error('trial response is unbound or has no verified result/model')
          const metrics = await Promise.race([
            Promise.resolve().then(() => judge({ request: structuredClone(request), response: structuredClone(response) })),
            expired
          ])
          if (!validMetrics(metrics)) throw Error('independent behavioral observation incomplete')
          pair[arm] = { artifact, requestDigest: request.digest, metrics: structuredClone(metrics) }
        } catch (error) {
          report.failures.push({ taskId: task.id, repeat, arm,
            reason: controller.signal.aborted ? 'trial_timeout_observe_before_retry' : 'unusable_trial_evidence',
            diagnosticDigest: canonicalDigest(String(error?.message ?? error)) })
          report.pairs.push(pair)
          break trials
        } finally { clearTimeout(timer) }
      }
      report.pairs.push(pair)
      if (!pair.baseline || !pair.removed) continue
      for (const dimension of ['taskSuccess', 'falseClaims', 'ruleViolations', 'requiredSourceDiscovery']) {
        const a = pair.baseline.metrics[dimension], b = pair.removed.metrics[dimension]
        if (a === b) continue
        const change = { taskId: task.id, repeat, dimension, baseline: a, removed: b }
        report.changes.push(change)
        if (typeof a === 'boolean' ? a && !b : b > a) report.regressions.push(change)
      }
    }
  }
  const allPass = report.pairs.length === tasks.length * repetitions &&
    report.pairs.every(p => [p.baseline, p.removed].every(arm =>
    arm?.metrics.taskSuccess && arm.metrics.requiredSourceDiscovery &&
    arm.metrics.falseClaims === 0 && arm.metrics.ruleViolations === 0))
  report.decision = boundary !== 'guidance' ? 'keep_boundary'
    : report.changes.length ? 'keep'
    : !report.failures.length && allPass ? 'propose_removal' : 'insufficient_evidence'
  return report
}

/** Jev may trim optional pinned context, never the required contract. */
export async function selectOptionalBuildContext({ task, chunks = [], apiKey, fetchImpl = fetch,
  usageLog, cacheDir }) {
  const taskText = bounded(task, MAX_TASK_CHARS)
  if (!Array.isArray(chunks) || chunks.length > MAX_OPTIONAL_CONTEXT)
    throw new Error("invalid optional build context")
  const pinned = chunks.length ? createPinnedBuildContext(chunks).contracts : []
  const hidden = { schema: "optional-context-selection.v1", status: "unavailable",
    reason: apiKey ? "service_error" : "no_api_key", model: JEV_MODEL,
    choices: pinned.map(chunk => ({ path: chunk.path, source_digest: chunk.content_digest,
      visibility: "hide" })), contracts: [] }
  if (!pinned.length) return { ...hidden, status: "skipped", reason: "no_optional_context" }
  if (!apiKey) return hidden
  const state = { task_class: "doctorcre-build", task: taskText, chunks: pinned }
  const questions = Object.fromEntries(pinned.map((chunk, index) => [`context_${index}`, {
    type: "choice",
    instructions: `How much of this optional pinned source should the build model see for the task? The required contract is already supplied separately. Choose the least detail that preserves useful task evidence.`,
    criteria: { hide: "Irrelevant to the current task.", short: "The first 600 characters suffice.",
      long: "The first 3000 characters are useful.", full: "The entire excerpt is needed." }
  }]))
  try {
    const body = await askJev({ model: JEV_MODEL, state, questions, apiKey,
      caller: "model-room-optional-context", fetchImpl, usageLog, cacheDir })
    if (body?.model !== JEV_MODEL) return { ...hidden, reason: "invalid_answer" }
    const parsed = pinned.map((_, index) => parseChoice(body.answers?.[`context_${index}`], VISIBILITY))
    if (parsed.some(choice => !choice)) return { ...hidden, reason: "invalid_answer" }
    const choices = pinned.map((chunk, index) => ({ path: chunk.path,
      source_digest: chunk.content_digest, visibility: parsed[index].choice,
      confidence: parsed[index].confidence }))
    const contracts = pinned.flatMap((chunk, index) => {
      const visibility = parsed[index].choice
      if (visibility === "hide") return []
      const excerpt = visibility === "full" ? chunk.excerpt : chunk.excerpt.slice(0,
        visibility === "short" ? 600 : 3000)
      return [{ ...chunk, excerpt, content_digest:
        `sha256:${createHash("sha256").update(excerpt).digest("hex")}` }]
    })
    return { schema: "optional-context-selection.v1", status: "available", reason: null,
      model: JEV_MODEL, choices, contracts }
  } catch {
    return hidden
  }
}

function routeKey(route) {
  return `${route.provider}/${route.model}/${route.effort}`
}

function validateRoute(route) {
  if (!route || typeof route !== "object") throw new Error("route is required")
  for (const key of ["provider", "model", "effort"]) bounded(route[key], 80)
  return { provider: route.provider, model: route.model, effort: route.effort }
}

function checkedCases(route, observations, verifyObservation) {
  const cases = new Set()
  let failed = false
  for (const observation of observations) {
    if (!verifyObservation(observation)) continue
    if (observation.route_key !== routeKey(route)) continue
    if (observation.oracle_status !== "pass" || observation.repository_status !== "pass") failed = true
    if (observation.oracle_status !== "pass" || observation.repository_status !== "pass" ||
        observation.model_readback !== route.model ||
        typeof observation.case_id !== "string" || !observation.case_id ||
        typeof observation.source_base !== "string" || !/^[0-9a-f]{40}$/.test(observation.source_base) ||
        typeof observation.oracle_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(observation.oracle_digest)) continue
    cases.add(observation.case_id)
  }
  return failed ? 0 : cases.size
}

function parseChoice(answer, keys) {
  if (answer?.type !== "choice" || !keys.includes(answer.choice) ||
      typeof answer.confidence !== "number" || answer.confidence < 0 || answer.confidence > 1 ||
      !answer.probabilities || typeof answer.probabilities !== "object" ||
      Object.keys(answer.probabilities).length !== keys.length) return null
  const values = keys.map(key => answer.probabilities[key])
  if (values.some(value => typeof value !== "number" || value < 0 || value > 1) ||
      Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.02) return null
  return { choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities }
}

/**
 * DoctorCRE build-task routing pilot. The trusted evaluator authenticates
 * observations; this function never accepts a caller's qualification claim.
 * Jev is a shadow preference until policy explicitly enables control after
 * enough distinct, independently checked cases.
 */
export async function routeDoctorCreBuild({ task, contracts, baseline, candidates, observations = [],
  verifyObservation, verifyControl, minimumCases = 3, controlEnabled = false, apiKey, fetchImpl = fetch,
  usageLog, cacheDir }) {
  const taskText = bounded(task, MAX_TASK_CHARS)
  const baselineRoute = validateRoute(baseline)
  if (!Array.isArray(contracts) || !contracts.length || !Array.isArray(candidates) ||
      !Array.isArray(observations) || typeof verifyObservation !== "function" ||
      !Number.isInteger(minimumCases) || minimumCases < 3) throw new Error("invalid model room inputs")
  const boundContracts = contracts.map(contract => {
    if (!contract || !/^[0-9a-f]{40}$/.test(contract.source_revision) ||
        !/^sha256:[0-9a-f]{64}$/.test(contract.content_digest)) throw new Error("contract provenance required")
    const excerpt = bounded(contract.excerpt, MAX_CONTRACT_CHARS)
    const actualDigest = `sha256:${createHash("sha256").update(excerpt).digest("hex")}`
    if (contract.content_digest !== actualDigest) throw new Error("contract digest mismatch")
    return { source_revision: contract.source_revision, path: bounded(contract.path, 300),
      content_digest: contract.content_digest, excerpt }
  })
  const routes = candidates.map(validateRoute)
  const keys = routes.map(routeKey)
  if (new Set(keys).size !== keys.length || keys.includes(routeKey(baselineRoute)))
    throw new Error("duplicate model room route")
  const qualifying = routes.map((route, index) => ({ ...route, key: keys[index],
    checked_cases: checkedCases(route, observations, verifyObservation) }))
  const eligible = qualifying.filter(route => route.checked_cases >= minimumCases)
  const state = { task_class: "doctorcre-build", task: taskText,
    contracts: boundContracts, baseline: baselineRoute,
    candidates: qualifying.map(({ key, checked_cases }) => ({ key, checked_cases })) }
  const result = { schema: "doctorcre-build-route.v1", state_digest: digest(state),
    selected_route: baselineRoute, selection_reason: controlEnabled
      ? (eligible.length ? "qualified_control_ready" : "baseline_only_qualified_route")
      : (eligible.length ? "shadow_mode" : "baseline_unqualified_pilot"),
    eligible_routes: eligible.map(route => route.key),
    qualifications: qualifying.map(({ key, checked_cases }) => ({ key, checked_cases, minimum_cases: minimumCases })),
    jev: { status: "unavailable", reason: "no_api_key", model: JEV_MODEL, shadow_choice: null } }
  if (!apiKey) return result
  const choiceRoutes = controlEnabled ? eligible : routes
  const choiceKeys = ["baseline", ...choiceRoutes.map(route => route.key)]
  if (choiceKeys.length === 1) return { ...result, jev: { status: "skipped",
    reason: "single_qualified_route", model: JEV_MODEL, shadow_choice: "baseline" } }
  const questions = { preferred_route: { type: "choice",
    instructions: "For this DoctorCRE build task and the exact contract excerpts, which listed route is most likely to produce a correct, efficient implementation? This is advisory; verified outcomes decide eligibility.",
    criteria: Object.fromEntries(choiceKeys.map(key => [key, key === "baseline"
      ? `Use the existing baseline ${routeKey(baselineRoute)}.` : `Use ${key}.`])) } }
  try {
    const body = await askJev({ model: JEV_MODEL, state, questions, apiKey,
      caller: "model-room-build-route", fetchImpl, usageLog, cacheDir })
    const choice = body?.model === JEV_MODEL ? parseChoice(body.answers?.preferred_route, choiceKeys) : null
    if (!choice) return { ...result, jev: { status: "unavailable", reason: "invalid_answer", model: JEV_MODEL, shadow_choice: null } }
    const chosenRoute = choiceRoutes.find(route => route.key === choice.choice)
    const selected = choice.choice === "baseline" ? baselineRoute : validateRoute(chosenRoute)
    const jev = { status: "available", reason: null, model: JEV_MODEL,
      shadow_choice: choice.choice, confidence: choice.confidence, probabilities: choice.probabilities }
    if (controlEnabled && typeof verifyControl === "function" &&
        verifyControl({ task_class: "doctorcre-build", state_digest: result.state_digest,
          route_key: choice.choice, checked_cases: qualifying.find(route => route.key === choice.choice)?.checked_cases ?? 0 }) === true &&
        choice.choice !== "baseline" && eligible.some(route => route.key === choice.choice))
      return { ...result, selected_route: selected, selection_reason: "qualified_jev_choice", jev }
    return { ...result, selection_reason: controlEnabled && choice.choice === "baseline"
      ? "jev_baseline_choice" : result.selection_reason, jev }
  } catch {
    return { ...result, jev: { status: "unavailable", reason: "service_error", model: JEV_MODEL, shadow_choice: null } }
  }
}
