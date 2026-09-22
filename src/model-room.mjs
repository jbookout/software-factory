import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
const JEV_MODEL = "jev-1.13.0"
const MAX_TASK_CHARS = 4000
const MAX_CONTRACT_CHARS = 12000
const MAX_BUILD_CONTRACTS = 8
const MAX_OPTIONAL_CONTEXT = 4
const VISIBILITY = ["hide", "short", "long", "full"]
export const MODEL_ROOM_EVIDENCE_SCHEMA = "doctorcre-build-evaluation-bundle.v1"
const EVIDENCE_SIGNATURE = /^hmac-sha256:[0-9a-f]{64}$/

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  return JSON.stringify(value)
}

function evidencePayload(bundle) {
  return { schema: MODEL_ROOM_EVIDENCE_SCHEMA, control: bundle.control,
    observations: bundle.observations }
}

function evidenceSignature(payload, key) {
  return `hmac-sha256:${createHmac("sha256", key).update(canonical(payload)).digest("hex")}`
}

function assertEvidenceKey(key) {
  if (typeof key !== "string" || Buffer.byteLength(key) < 32)
    throw new Error("model room evaluation key must be at least 32 bytes")
}

/** Sign independently checked observations with the evaluator's runtime key. */
export function signEvaluationBundle({ control, observations }, key) {
  assertEvidenceKey(key)
  if (!control || control.task_class !== "doctorcre-build" ||
      control.mode !== "qualified_only" || !Number.isInteger(control.minimum_cases) ||
      control.minimum_cases < 3 || !Array.isArray(observations))
    throw new Error("invalid model room evaluation bundle")
  const payload = { schema: MODEL_ROOM_EVIDENCE_SCHEMA, control, observations }
  return { ...payload, signature: evidenceSignature(payload, key) }
}

/** Authenticate one bundle and return identity-bound verifier callbacks. */
export function authenticateEvaluationBundle(bundle, key) {
  assertEvidenceKey(key)
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) ||
      Object.keys(bundle).sort().join(",") !== "control,observations,schema,signature" ||
      bundle.schema !== MODEL_ROOM_EVIDENCE_SCHEMA ||
      !EVIDENCE_SIGNATURE.test(bundle.signature ?? ""))
    throw new Error("invalid model room evaluation bundle")
  const signed = signEvaluationBundle(evidencePayload(bundle), key)
  const actual = Buffer.from(bundle.signature.slice("hmac-sha256:".length), "hex")
  const expected = Buffer.from(signed.signature.slice("hmac-sha256:".length), "hex")
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
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

/** Jev may trim optional pinned context, never the required contract. */
export async function selectOptionalBuildContext({ task, chunks = [], apiKey, fetchImpl = fetch }) {
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
    const response = await fetchImpl(JEV_ENDPOINT, { method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }), signal: AbortSignal.timeout(1500) })
    if (!response.ok) return hidden
    const body = await response.json()
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
  verifyObservation, verifyControl, minimumCases = 3, controlEnabled = false, apiKey, fetchImpl = fetch }) {
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
    const response = await fetchImpl(JEV_ENDPOINT, { method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }), signal: AbortSignal.timeout(1500) })
    if (!response.ok) return { ...result, jev: { status: "unavailable", reason: "service_error", model: JEV_MODEL, shadow_choice: null } }
    const body = await response.json()
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
