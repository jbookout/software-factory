import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import Ajv2020 from "ajv/dist/2020.js"

const schema = JSON.parse(readFileSync(new URL("../schemas/factory-evidence.schema.json", import.meta.url)))
const ajv = new Ajv2020({ strict: true })
ajv.addSchema(schema)
const validator = name => ajv.getSchema(`${schema.$id}#/$defs/${name}`)
const validateArtifact = validator("artifact")
const validateCandidate = validator("candidate")
const validateObservation = validator("observation")

// The observed outcome each phase must show: the defect on the baseline, then its absence.
const EXPECTED = { before: "failed", after: "passed" }

const digestOf = bytes => createHash("sha256").update(bytes).digest("hex")

// Reads evidence bytes from a store that outlives the job's scratch environment.
// Returns null for anything outside the store or unreadable.
export function createArtifactReader(root) {
  const base = path.resolve(root)
  return async ref => {
    const file = path.resolve(base, ref)
    const relative = path.relative(base, file)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null
    return readFile(file).catch(() => null)
  }
}

// A build proves nothing unless it names a new revision and the digest of what it built.
export function buildIdentity(data, sourceRevision) {
  const candidate = { revision: data?.candidateRevision, buildDigest: data?.buildDigest }
  if (!validateCandidate(candidate)) return { candidate: null, stopped: "build:unbound" }
  if (candidate.revision === sourceRevision) return { candidate: null, stopped: "build:no-change" }
  return { candidate, stopped: null }
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
export async function acceptEvidence({ phase, criterionId, binding, records, readArtifact, priorDigests = [] }) {
  const failed = []
  const blocked = []
  const artifacts = []
  if (typeof readArtifact !== "function") {
    return { result: "blocked", reasons: ["no artifact reader is configured"], artifacts }
  }

  async function read(artifact) {
    if (!validateArtifact(artifact)) return void failed.push("malformed artifact reference")
    const bytes = await Promise.resolve().then(() => readArtifact(artifact.ref)).catch(() => null)
    if (!bytes) return void blocked.push(`unreadable: ${artifact.ref}`)
    if (!bytes.length) return void failed.push(`empty: ${artifact.ref}`)
    const digest = digestOf(bytes)
    if (digest !== artifact.digest) return void failed.push(`digest mismatch: ${artifact.ref}`)
    if (priorDigests.includes(digest)) return void failed.push(`reused from an earlier phase: ${artifact.ref}`)
    artifacts.push({ ref: artifact.ref, digest })
    return bytes
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
    else if (observation.outcome !== EXPECTED[phase]) {
      failed.push(`observed ${observation.outcome}, expected ${EXPECTED[phase]}: ${record.artifact.ref}`)
    }
  }
  const result = failed.length ? "failed" : blocked.length ? "blocked" : "passed"
  return { result, reasons: [...failed, ...blocked], artifacts }
}
