import test from "node:test"
import assert from "node:assert/strict"
import { deliveryPrompt } from "../src/pr-delivery-prompts.mjs"

const load = () => import("../src/pr-delivery-receipts.mjs")
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40)
const repo = "fixture/producer", consumer = "fixture/consumer"
const reproduction = { argv: ["node", "reproduce.mjs"], acknowledgement: "property-checked" }
function inputs(ownerRepo = repo) {
  const brief = { schema: "factory-delivery-brief/v1", repo, pr: 1481, head: A,
    reviewDigest: "d".repeat(64), builderId: "builder-task", base: C, environment: "node-fixture",
    findings: [{ id: "1", ownerRepo, consumer: { repo: consumer, head: C },
      originalHead: A, contractPin: A, reproduction, ownedPaths: ["feature.mjs"] }] }
  const receipt = { schema: "factory-fix-receipt/v1", role: "builder", builderId: brief.builderId,
    repo, pr: 1481, priorHead: A, head: B, reviewDigest: brief.reviewDigest,
    resolutions: [{ id: "1", ownerRepo, head: B, consumer: { repo: consumer, head: C },
      contractPin: B, changedPaths: ["feature.mjs"], reproduction: structuredClone(reproduction) }], dependencies: [] }
  return { brief, receipt }
}
const replay = async ({ head }) => ({ code: head === A ? 1 : 0, stdout: "property-checked", stderr: "", pid: 42, timedOut: false })
const prove = async (input, run = replay) => (await load()).proveFixReceipt(input, run)

test("every original finding needs an executor receipt; headings or resealing cannot confirm", async () => {
  const input = inputs()
  await assert.rejects(prove({ ...input, receipt: null }), /receipt/i)
  await assert.rejects(prove({ ...input, receipt: { ...input.receipt, resolutions: [] } }), /finding|resolution/i)
  await assert.rejects(prove(input, async () => ({ code: 0, stdout: "property-checked", pid: 42 })), /control/i)
  const result = await prove(input)
  assert.equal(result.status, "resolved")
  assert.equal(result.resolutions[0].before.code, 1)
  assert.equal(result.resolutions[0].after.code, 0)
})
for (const [name, mutate] of [
  ["head", i => i.receipt.head = C],
  ["review", i => i.receipt.reviewDigest = "e".repeat(64)],
  ["owner", i => i.receipt.resolutions[0].ownerRepo = consumer],
  ["consumer", i => i.receipt.resolutions[0].consumer.head = B],
  ["paths", i => i.receipt.resolutions[0].changedPaths = ["unowned.mjs"]],
  ["reproduction", i => i.receipt.resolutions[0].reproduction.argv = ["node", "other.mjs"]],
  ["pin", i => i.receipt.resolutions[0].contractPin = A],
  ["duplicate", i => i.receipt.resolutions.push(structuredClone(i.receipt.resolutions[0]))]
]) test(`substituted ${name} proof is refused independently`, async () => {
  const input = inputs(); mutate(input)
  await assert.rejects(prove({ ...input, expectedHead: B }), /binding|finding|path|pin|duplicate|reproduction/i)
})
for (const [name, result] of [
  ["empty exit-zero", { code: 0, stdout: "", pid: 42 }],
  ["refusal", { code: 75, stdout: "property-checked", pid: 42 }],
  ["nonzero", { code: 1, stdout: "property-checked", pid: 42 }],
  ["partial", { code: 0, stdout: "property-", pid: 42 }],
  ["missing acknowledgement", { code: 0, stdout: "done", pid: 42 }],
  ["timeout", { code: 0, stdout: "property-checked", pid: 42, timedOut: true }]
]) test(`repaired ${name} is never evidence of success`, async () => {
  await assert.rejects(prove(inputs(), async args => args.head === A ? replay(args) : result), /repaired|acknowledgement/i)
})
test("transport exception refuses proof without exposing subprocess diagnostics", async () => {
  await assert.rejects(prove(inputs(), async () => { throw new Error("CANARY_CLIENT CANARY_SECRET") }), error =>
    /replay/i.test(error.message) && !/CANARY/.test(error.message))
})
test("CARR 1481 Undo ownership and app 123 producer pin become specific owned waits", async () => {
  const input = inputs(consumer)
  input.receipt.resolutions = []
  input.receipt.dependencies = [{ id: "1", ownerRepo: consumer, head: A, contractPin: A,
    wakeCondition: "tested-consumer-pin", deadline: "2026-10-05T00:00:00Z" }]
  let calls = 0
  const waiting = await prove(input, async () => { calls++; return {} })
  assert.equal(waiting.status, "dependency")
  assert.equal(waiting.dependencies[0].ownerRepo, consumer)
  assert.equal(calls, 0)
  const ready = inputs(consumer)
  assert.equal((await prove(ready)).status, "resolved")
})
function selfReview() {
  return { schema: "factory-self-review/v1", role: "builder", builderId: "builder-task", repo,
    head: B, base: C, environment: "node-fixture", issues: [{ id: "seeded-defect", repair: "corrected predicate", check: "proof" }],
    checks: [{ id: "proof", head: B, argv: ["node", "reproduce.mjs"], acknowledgement: "property-checked",
      control: { head: A, argv: ["node", "reproduce.mjs"] } }],
    checklist: [..."abcdefghijk"].map(id => ({ id, status: "checked", checks: ["proof"] })),
    requirements: ["oracle", "consumers", "transitions", "results", "sinks", "repository"].map(id => ({ id, status: "checked", checks: ["proof"] })),
    testContract: { fixtureOwner: repo, resources: ["isolated-worktree"], selectionDependencies: ["feature.mjs"], globalState: false },
    instructionEval: { status: "na", relevanceTest: "Repository has no registered steering surface matching changed paths" } }
}
const self = async value => (await load()).proveSelfReview(value,
  { repo, head: B, base: C, environment: "node-fixture", builderId: "builder-task" }, replay)
test("self-review executes checks and repair replays; unchecked headings fail", async () => {
  const receipt = selfReview()
  assert.equal((await self(receipt)).role, "builder")
  receipt.checklist[0] = { id: "a", status: "checked", checks: [] }
  await assert.rejects(self(receipt), /check|evidence|schema/i)
})
test("every checklist and builder requirement is required; N/A carries a failed relevance test", async () => {
  for (const field of ["checklist", "requirements"]) {
    const receipt = selfReview(); receipt[field].pop()
    await assert.rejects(self(receipt), /checklist|requirement|schema/i)
    const na = selfReview(); na[field][0] = { id: na[field][0].id, status: "na" }
    await assert.rejects(self(na), /relevance|schema/i)
  }
})
test("self-review binds source/base/environment and fails a still-broken seeded repair", async () => {
  for (const field of ["head", "base", "environment", "builderId"]) {
    const receipt = selfReview(); receipt[field] = field.endsWith("Id") || field === "environment" ? "other" : A
    await assert.rejects(self(receipt), /binding/i)
  }
  const receipt = selfReview(); receipt.checks[0].head = A
  await assert.rejects(self(receipt), /binding/i)
})
test("raw execution errors, issue text and command canaries do not enter persisted proof projections", async () => {
  const receipt = selfReview(); receipt.issues[0].repair = "CANARY_CLIENT CANARY_SECRET"
  receipt.checks[0].argv.push("CANARY_SECRET")
  receipt.checks[0].control.argv.push("CANARY_SECRET")
  const proof = await self(receipt)
  assert.doesNotMatch(JSON.stringify(proof), /CANARY/)
  assert.doesNotMatch(JSON.stringify(await prove(inputs(), async args => ({ ...await replay(args), stderr: "CANARY_SECRET" }))), /CANARY/)
})
test("self-review snapshots identity before replay and persists only declared binding fields", async () => {
  const binding = { repo, head: B, base: C, environment: "node-fixture", builderId: "builder-task", extra: "CANARY_SECRET" }
  const proof = await (await load()).proveSelfReview(selfReview(), binding, async args => {
    binding.head = A; return replay(args)
  })
  assert.equal(proof.head, B)
  assert.doesNotMatch(JSON.stringify(proof), /CANARY/)
})

test("registered steering cannot use N/A for its instruction eval", async () => {
  await assert.rejects((await load()).proveSelfReview(selfReview(),
    { repo, head: B, base: C, environment: "node-fixture", builderId: "builder-task", registeredSteering: true }, replay), /instruction eval/i)
})

test("receipt formatting, finding order and narrative do not mint new resolution eligibility", async () => {
  const first = inputs()
  first.brief.findings.push({ ...structuredClone(first.brief.findings[0]), id: "2" })
  first.receipt.resolutions.push({ ...structuredClone(first.receipt.resolutions[0]), id: "2" })
  const a = await prove(first)
  const reordered = structuredClone(first)
  reordered.receipt = Object.fromEntries(Object.entries(reordered.receipt).reverse())
  reordered.receipt.resolutions.reverse()
  reordered.receipt.resolutions[0].consumer = { head: C, repo: consumer }
  reordered.brief.reviewDigest = reordered.receipt.reviewDigest = "f".repeat(64)
  const b = await prove(reordered)
  assert.match(a.evidenceDigest, /^[a-f0-9]{64}$/)
  assert.equal(a.evidenceDigest, b.evidenceDigest)
})
test("builder runs the identical full checklist before PR creation, with no approval/posting instruction", async () => {
  const full = deliveryPrompt("review", { repo, pr: 7, head: B })
  const local = deliveryPrompt("self-review", { repo, head: B, base: C })
  for (const letter of "abcdefghijk") {
    const line = full.split("\n").find(l => l.startsWith(`(${letter})`))
    assert.ok(line && local.includes(line), letter)
  }
  assert.match(local, /before.*PR creation/i)
  assert.doesNotMatch(local, /First line exactly APPROVE|factory posts it|Return ONE review comment/)
  for (const word of ["failing control", "consumers", "pending", "empty exit-zero", "canary", "current source", "instruction eval", "fixture ownership"])
    assert.ok(local.includes(word), word)
})
