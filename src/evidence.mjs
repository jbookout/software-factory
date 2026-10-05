import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Ajv2020 from "ajv/dist/2020.js"
import { runProcess } from "./process-runner.mjs"

const schema = JSON.parse(readFileSync(new URL("../schemas/factory-evidence.schema.json", import.meta.url)))
const ajv = new Ajv2020({ strict: true })
ajv.addSchema(schema)
const validator = name => ajv.getSchema(`${schema.$id}#/$defs/${name}`)
const validateArtifact = validator("artifact")
const validateCandidate = validator("candidate")
const validateObservation = validator("observation")

const DEFAULT_LIMITS = { timeoutMs: 5000, maxBytes: 10 * 1024 * 1024 }

export function evidenceReadLimits(input = {}) {
  const limits = { ...DEFAULT_LIMITS, ...input }
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw Error(`invalid evidence ${key}`)
  }
  return limits
}

const digestOf = bytes => createHash("sha256").update(bytes).digest("hex")

// Reads evidence bytes from a store that outlives the job's scratch environment.
// Pins the configured store identity. The POSIX helper opens each component
// relative to a held directory descriptor with O_NOFOLLOW (no check/use gap).
// Python 3 is required on macOS/Linux; unsupported stores fail closed.
export function createArtifactReader(root, options = {}) {
  const limits = evidenceReadLimits(options)
  let store
  try {
    const base = realpathSync(root)
    const stat = statSync(base)
    if (stat.isDirectory()) store = { root: base, device: stat.dev, inode: stat.ino }
  } catch { /* Missing/unreadable stores return null. */ }
  return async (ref, readOptions = {}) => {
    if (!store || typeof ref !== "string" || path.isAbsolute(ref) ||
        ref.split(/[\\/]/).some(part => part === "..")) return null
    const timeoutMs = Math.min(limits.timeoutMs, readOptions.timeoutMs ?? limits.timeoutMs)
    const maxBytes = Math.min(limits.maxBytes, readOptions.maxBytes ?? limits.maxBytes)
    try {
      const result = await runProcess(["python3", fileURLToPath(new URL("./read-artifact.py", import.meta.url))], {
        input: JSON.stringify({ ...store, ref, max_bytes: maxBytes }), timeoutMs,
        maxOutputBytes: Math.ceil(maxBytes / 3) * 4 + 64
      })
      if (result.code !== 0 || result.timedOut || result.overflow) return null
      const encoded = JSON.parse(result.stdout)
      return typeof encoded === "string" ? Buffer.from(encoded, "base64") : null
    } catch { return null }
  }
}

// A build proves nothing unless it names a new revision and the digest of what it built.
export function buildIdentity(data, sourceRevision) {
  const candidate = { revision: data?.candidateRevision, buildDigest: data?.buildDigest }
  if (!validateCandidate(candidate)) return { candidate: null, stopped: "build:unbound" }
  if (candidate.revision === sourceRevision) return { candidate: null, stopped: "build:no-change" }
  return { candidate: Object.freeze(candidate), stopped: null }
}

// Reads artifacts under one shared deadline and checks each against its recorded digest.
// Returns { bytes, digest } or a failed/blocked reason; never throws for a bad artifact.
export function createBoundReader({ readArtifact, limits: inputLimits, priorDigests = [] }) {
  const limits = evidenceReadLimits(inputLimits)
  const deadline = Date.now() + limits.timeoutMs
  priorDigests = [...priorDigests]
  return async artifact => {
    if (!validateArtifact(artifact)) return { failed: "malformed artifact reference" }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { blocked: `read deadline exceeded: ${artifact.ref}` }
    const controller = new AbortController()
    let timer
    let bytes
    try {
      bytes = await Promise.race([
        Promise.resolve().then(() => readArtifact(artifact.ref, {
          signal: controller.signal, maxBytes: limits.maxBytes, timeoutMs: remaining
        })),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort()
          reject(Error("read deadline exceeded"))
        }, remaining) })
      ])
    } catch (error) {
      return { blocked: `${controller.signal.aborted ? "read deadline exceeded" : "unreadable"}: ${artifact.ref}` }
    } finally { clearTimeout(timer) }
    if (bytes === null || bytes === undefined) return { blocked: `unreadable: ${artifact.ref}` }
    if (!Buffer.isBuffer(bytes)) return { failed: `invalid reader byte contract: ${artifact.ref}` }
    if (bytes.length > limits.maxBytes) return { failed: `artifact size limit exceeded: ${artifact.ref}` }
    if (!bytes.length) return { failed: `empty: ${artifact.ref}` }
    const digest = digestOf(bytes)
    if (digest !== artifact.digest) return { failed: `digest mismatch: ${artifact.ref}` }
    if (priorDigests.includes(digest)) return { failed: `reused from an earlier phase: ${artifact.ref}` }
    return { bytes, digest }
  }
}

// Decides whether a phase's evidence proves the criterion, asking in order:
// 1. Can artifacts be read at all? If not, blocked.
// 2. Is there an observation record for this criterion? If not, failed.
// 3. For each record and attachment: readable (else blocked), non-empty, matching its
//    recorded digest and not reused from an earlier phase (else failed)?
// 4. Is the artifact a valid observation of this criterion on the bound revision/build?
//    If not, failed.
// 5. Did the observer report blocked? Then blocked. Otherwise its outcome must equal
//    the phase's expected outcome, else failed.
// Any failed reason makes the verdict failed; otherwise any blocked reason makes it blocked.
// Digests bind bytes, not truth: this rejects labels and stale or copied artifacts, but
// it does not authenticate who wrote the observation.
export async function acceptEvidence({ phase, kind, criterionId, binding, records, readArtifact,
  priorDigests = [], limits: inputLimits }) {
  // Acceptance uses snapshots even while an injected reader yields control.
  binding = structuredClone(binding)
  records = structuredClone(records)
  const expected = phase === "after" ? ["passed"] : kind === "bug" ? ["failed"] : ["passed", "failed"]
  const failed = []
  const blocked = []
  const artifacts = []
  if (typeof readArtifact !== "function") {
    return { result: "blocked", reasons: ["no artifact reader is configured"], artifacts }
  }
  const readBound = createBoundReader({ readArtifact, limits: inputLimits, priorDigests })

  async function read(artifact) {
    const result = await readBound(artifact)
    if (result.failed) return void failed.push(result.failed)
    if (result.blocked) return void blocked.push(result.blocked)
    artifacts.push({ ref: artifact.ref, digest: result.digest })
    return result.bytes
  }

  const relevant = records.filter(record => record?.kind === "observation" && record.criterionId === criterionId)
  if (!relevant.length) failed.push(`no ${phase} evidence for criterion ${criterionId}`)
  for (const record of relevant) {
    const bytes = await read(record.artifact)
    if (!bytes) continue
    let observation
    try { observation = JSON.parse(bytes.toString("utf8")) } catch { observation = null }
    if (!validateObservation(observation)) {
      failed.push(`not an observation: ${record.artifact.ref}`)
      continue
    }
    if (observation.criterionId !== criterionId) failed.push(`observes another criterion: ${record.artifact.ref}`)
    for (const [field, value] of Object.entries(binding)) {
      if (observation[field] !== value) failed.push(`stale ${field}: ${record.artifact.ref}`)
    }
    for (const attachment of observation.attachments) await read(attachment)
    if (observation.outcome === "blocked") blocked.push(`observer blocked: ${record.artifact.ref}`)
    else if (!expected.includes(observation.outcome)) {
      failed.push(`observed ${observation.outcome}, expected ${expected.join(" or ")}: ${record.artifact.ref}`)
    }
  }
  const result = failed.length ? "failed" : blocked.length ? "blocked" : "passed"
  return { result, reasons: [...failed, ...blocked], artifacts }
}

// Effect identity binds semantic input; retries keep the same explicit attempt.
export function deliveryEffectId({ repo, pr, head, action, attempt = 1, policy = "pr-delivery/v1" }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "") ||
      repo.split("/").some(part => part === "." || part === "..") ||
      !Number.isSafeInteger(pr) || pr <= 0 || !/^[0-9a-f]{40}$/.test(head ?? "") ||
      typeof action !== "string" || !action || !Number.isSafeInteger(attempt) || attempt <= 0 ||
      typeof policy !== "string" || !policy) throw Error("invalid delivery effect binding")
  return digestOf(JSON.stringify([repo, pr, head, action, policy, attempt]))
}
