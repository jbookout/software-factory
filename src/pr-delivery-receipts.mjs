import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import Ajv2020 from "ajv/dist/2020.js"
import { DeliveryError } from "./pr-delivery-state.mjs"
import { canonicalDigest, canonicalJson } from "./canonical.mjs"

const schema = JSON.parse(readFileSync(new URL("../schemas/pr-delivery.schema.json", import.meta.url)))
const ajv = new Ajv2020({ strict: true })
ajv.addSchema(schema)
const validators = Object.fromEntries(["brief", "fix", "selfReview", "paths"].map(kind =>
  [kind, ajv.compile({ $ref: `${schema.$id}#/$defs/${kind}` })]))
export const deliveryDigest = value => typeof value === "string"
  ? createHash("sha256").update(value).digest("hex") : canonicalDigest(value)
export const builderRequirements = {
  oracle: "Break only the claimed property first; show the actual adapter rejects the failing control and a clean control passes.",
  consumers: "Find all predicate/schema/renderer consumers; execute parity checks, reuse one authority and remove replaced paths.",
  transitions: "For stateful changes, test pending/refused/unknown/retry/recovery/close/reopen/disposal and valid next actions.",
  results: "Test empty exit-zero, refusal, nonzero, partial, exception and missing acknowledgement independently.",
  sinks: "Test canary secrets/client identifiers in raw persisted bytes and subprocess errors.",
  repository: "Run applicable repository checks against current source/base and the actual worker environment."
}
export function validateDeliveryReceipt(kind, value) {
  if (!validators[kind]?.(value)) throw new DeliveryError(`invalid ${kind} receipt schema`, 2)
  if (kind === "brief") validateFindingSources(value)
  return value
}
const same = (a, b) => canonicalJson(a) === canonicalJson(b)
const unique = (rows, label) => {
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new DeliveryError(`duplicate ${label}`, 2)
}

const sorted = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id))
const manifest = brief => sorted(brief.findings).map(f => ({ ...f, ownedPaths: [...f.ownedPaths].sort() }))
const manifestDigest = brief => canonicalDigest({ repo: brief.repo, pr: brief.pr, head: brief.head, findings: manifest(brief) })
const evidenceDigest = (brief, head, resolutions, dependencies) => canonicalDigest({ repo: brief.repo, pr: brief.pr, head,
  findings: manifest(brief),
  resolutions: sorted(resolutions).map(({ id, ownerRepo, head, consumer, contractPin }) => ({ id, ownerRepo, head, consumer, contractPin })),
  dependencies: sorted(dependencies).map(({ id, ownerRepo, head, contractPin }) => ({ id, ownerRepo, head, contractPin })) })
const repairedConsumer = (brief, finding, head, ownerHead) => ({ ...finding.consumer,
  head: finding.consumer.repo === brief.repo ? head :
    finding.consumer.repo === finding.ownerRepo && finding.consumer.head === finding.originalHead ? ownerHead : finding.consumer.head })
function validateFindingSources(brief) {
  for (const f of brief.findings) {
    if (f.ownerRepo === brief.repo && (f.originalHead !== brief.head || f.contractPin !== brief.head) ||
        f.consumer.repo === brief.repo && f.consumer.head !== brief.head)
      throw new DeliveryError("finding original source does not match reviewed head", 2)
  }
}

// Both cached callers cross this seam. Changed manifests or damaged semantic
// evidence must fail before a worker can repair or confirm anything.
export function validateResolutionProof(proof, brief, head) {
  validateDeliveryReceipt("brief", brief)
  if (!proof || proof.schema !== "factory-resolution-proof/v1" || proof.role !== "builder" ||
      proof.repo !== brief.repo || proof.pr !== brief.pr || proof.head !== head || proof.priorHead !== brief.head ||
      proof.reviewDigest !== brief.reviewDigest || proof.builderId !== brief.builderId ||
      proof.manifestDigest !== manifestDigest(brief) || !Array.isArray(proof.resolutions) || !Array.isArray(proof.dependencies))
    throw new DeliveryError("resolution receipt manifest binding mismatch", 2)
  unique([...proof.resolutions, ...proof.dependencies], "proof finding")
  if (proof.resolutions.length + proof.dependencies.length !== brief.findings.length ||
      [...proof.resolutions, ...proof.dependencies].some(r => !brief.findings.some(f => f.id === r.id)) ||
      proof.status !== (proof.dependencies.length ? "dependency" : "resolved") ||
      proof.evidenceDigest !== evidenceDigest(brief, head, proof.resolutions, proof.dependencies))
    throw new DeliveryError("resolution receipt semantic evidence binding mismatch", 2)
  for (const f of brief.findings) {
    const r = proof.resolutions.find(r => r.id === f.id), d = proof.dependencies.find(r => r.id === f.id)
    if (d) {
      if (d.ownerRepo !== f.ownerRepo || d.head !== f.originalHead || d.contractPin !== f.contractPin)
        throw new DeliveryError("dependency proof binding mismatch", 2)
      continue
    }
    if (r.ownerRepo !== f.ownerRepo || f.ownerRepo === brief.repo && r.head !== head ||
        r.head === f.originalHead || r.contractPin !== r.head || r.contractPin === f.contractPin ||
        !same(r.consumer, repairedConsumer(brief, f, head, r.head)) || !Array.isArray(r.changedPaths) ||
        !r.changedPaths.length || r.changedPaths.some(p => !f.ownedPaths.includes(p)) ||
        r.before?.head !== f.originalHead || r.after?.head !== r.head || r.before?.code !== 1 || r.after?.code !== 0 ||
        !r.before?.pid || !r.after?.pid || [r.before, r.after].some(p => p.commandDigest !== deliveryDigest(f.reproduction.argv)))
      throw new DeliveryError("resolution proof source/replay binding mismatch", 2)
  }
  return proof
}

// Read actual subprocess results. Never persist raw commands, narrative or output:
// the projection binds their bytes by digest, including failure diagnostics.
async function replayProof(run, input, expected) {
  let result
  const started = performance.now()
  try { result = await run(structuredClone(input)) }
  catch { throw new DeliveryError("replay transport exception", 2) }
  const acknowledged = typeof result?.stdout === "string" && result.stdout.split(/\r?\n/).includes(input.acknowledgement)
  const validCode = expected === "control" ? result?.code === 1 : result?.code === 0
  if (!validCode || !acknowledged || !result.pid || result.timedOut || result.overflow)
    throw new DeliveryError(`${expected} replay failed or missing acknowledgement`, 2)
  return { head: input.head, code: result.code, elapsedMs: performance.now() - started, commandDigest: deliveryDigest(input.argv),
    outputDigest: deliveryDigest([result.stdout, result.stderr ?? ""]), pid: result.pid }
}

export async function proveFixReceipt({ brief, receipt, expectedHead = receipt?.head }, run) {
  // Snapshot before any asynchronous replay: callers cannot substitute pins mid-flight.
  brief = structuredClone(validateDeliveryReceipt("brief", brief))
  receipt = structuredClone(validateDeliveryReceipt("fix", receipt))
  if (receipt.repo !== brief.repo || receipt.pr !== brief.pr || receipt.priorHead !== brief.head ||
      receipt.reviewDigest !== brief.reviewDigest || receipt.builderId !== brief.builderId || receipt.head !== expectedHead)
    throw new DeliveryError("fix receipt binding mismatch", 2)
  unique(brief.findings, "finding"); unique([...receipt.resolutions, ...receipt.dependencies], "resolution finding")
  const ids = new Set(brief.findings.map(f => f.id))
  if (receipt.resolutions.length + receipt.dependencies.length !== ids.size ||
      [...receipt.resolutions, ...receipt.dependencies].some(r => !ids.has(r.id)))
    throw new DeliveryError("missing or substituted finding resolution", 2)
  const resolutions = [], dependencies = []
  for (const finding of brief.findings) {
    const dependency = receipt.dependencies.find(r => r.id === finding.id)
    if (dependency) {
      if (dependency.ownerRepo !== finding.ownerRepo || dependency.head !== finding.originalHead ||
          dependency.contractPin !== finding.contractPin || !Number.isFinite(Date.parse(dependency.deadline)))
        throw new DeliveryError("dependency finding binding mismatch", 2)
      // Free text wake instructions stay with the executor; state records carry a
      // typed next action, exact input and its digest without sensitive narrative.
      dependencies.push({ id: finding.id, ownerRepo: dependency.ownerRepo, head: dependency.head,
        contractPin: dependency.contractPin, wakeDigest: deliveryDigest(dependency.wakeCondition),
        deadline: dependency.deadline, nextAction: "owner-tested-pin-receipt" })
      continue
    }
    const resolution = receipt.resolutions.find(r => r.id === finding.id)
    const expectedConsumer = repairedConsumer(brief, finding, receipt.head, resolution.head)
    if (resolution.ownerRepo !== finding.ownerRepo ||
        (finding.ownerRepo === brief.repo && resolution.head !== receipt.head) ||
        !same(resolution.consumer, expectedConsumer) || !same(resolution.reproduction, finding.reproduction))
      throw new DeliveryError("resolution owner/consumer/reproduction binding mismatch", 2)
    if (resolution.head === finding.originalHead || resolution.contractPin === finding.contractPin || resolution.contractPin !== resolution.head)
      throw new DeliveryError("unchanged head or contract pin cannot resolve finding", 2)
    if (resolution.changedPaths.some(p => !finding.ownedPaths.includes(p))) throw new DeliveryError("unowned changed path", 2)
    const common = { repo: finding.ownerRepo, findingId: finding.id, consumer: finding.consumer, ...finding.reproduction }
    const before = await replayProof(run, { ...common, head: finding.originalHead, contractPin: finding.contractPin }, "control")
    const after = await replayProof(run, { ...common, consumer: resolution.consumer, head: resolution.head, contractPin: resolution.contractPin,
      priorHead: finding.originalHead, changedPaths: resolution.changedPaths }, "repaired")
    resolutions.push({ id: finding.id, ownerRepo: finding.ownerRepo, head: resolution.head,
      consumer: resolution.consumer, contractPin: resolution.contractPin, changedPaths: resolution.changedPaths, before, after })
  }
  // Eligibility changes only when a finding's source/consumer/reproduction or
  // repaired pin changes. Formatting, narrative and replay timing are not inputs.
  return validateResolutionProof({ schema: "factory-resolution-proof/v1", role: "builder", repo: brief.repo, pr: brief.pr,
    head: receipt.head, priorHead: brief.head, reviewDigest: brief.reviewDigest, builderId: brief.builderId,
    receiptDigest: deliveryDigest(receipt), manifestDigest: manifestDigest(brief),
    evidenceDigest: evidenceDigest(brief, receipt.head, resolutions, dependencies), status: dependencies.length ? "dependency" : "resolved", resolutions, dependencies }, brief, receipt.head)
}

export async function proveSelfReview(receipt, binding, run) {
  receipt = structuredClone(validateDeliveryReceipt("selfReview", receipt))
  binding = Object.fromEntries(["repo", "head", "base", "environment", "builderId", "registeredSteering"]
    .filter(k => binding[k] !== undefined).map(k => [k, binding[k]]))
  if (["repo", "head", "base", "environment", "builderId"].some(k => receipt[k] !== binding[k]))
    throw new DeliveryError("self-review source/base/environment binding mismatch", 2)
  unique(receipt.checks, "check")
  const requireRows = (rows, expected, label) => {
    unique(rows, label)
    if (rows.length !== expected.length || expected.some(id => !rows.some(r => r.id === id)))
      throw new DeliveryError(`missing ${label}`, 2)
    for (const row of rows) if (row.status === "checked" && row.checks.some(id => !receipt.checks.some(c => c.id === id)))
      throw new DeliveryError(`unchecked ${label} evidence`, 2)
  }
  requireRows(receipt.checklist, [..."abcdefghijk"], "checklist")
  requireRows(receipt.requirements, Object.keys(builderRequirements), "requirements")
  const oracle = receipt.requirements.find(r => r.id === "oracle")
  if (oracle.status !== "checked" || !oracle.checks.some(id => receipt.checks.some(c => c.id === id && c.control)))
    throw new DeliveryError("oracle needs executed failing control evidence", 2)
  if (binding.registeredSteering && receipt.instructionEval.status !== "checked") throw new DeliveryError("registered steering requires instruction eval", 2)
  if (receipt.instructionEval.status === "checked" && receipt.instructionEval.checks.some(id => !receipt.checks.some(c => c.id === id)))
    throw new DeliveryError("missing instruction eval check", 2)
  for (const issue of receipt.issues) if (!receipt.checks.some(c => c.id === issue.check && c.control))
    throw new DeliveryError("repair needs the same failing reproduction", 2)
  const checks = []
  for (const check of receipt.checks) {
    if (check.head !== binding.head) throw new DeliveryError("check source binding mismatch", 2)
    const common = { repo: receipt.repo, ...check }
    let before = null
    if (check.control) {
      if (check.control.head === check.head || !same(check.control.argv, check.argv))
        throw new DeliveryError("control must replay the same failing reproduction", 2)
      before = await replayProof(run, { ...common, ...check.control }, "control")
    }
    const after = await replayProof(run, common, "repaired")
    checks.push({ id: check.id, before, after })
  }
  return { schema: "factory-self-review-proof/v1", role: "builder", ...binding,
    receiptDigest: deliveryDigest(receipt), checks, issueDigests: receipt.issues.map(deliveryDigest),
    measurements: { checked: checks.length, issuesReplayed: receipt.issues.length,
      replayMs: checks.reduce((sum, check) => sum + (check.before?.elapsedMs ?? 0) + check.after.elapsedMs, 0), modelTokens: null },
    checklist: receipt.checklist.map(row => ({ id: row.id, status: row.status, evidenceDigest: deliveryDigest(row) })),
    requirements: receipt.requirements.map(row => ({ id: row.id, status: row.status, evidenceDigest: deliveryDigest(row) })) }
}
