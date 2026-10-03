import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import * as factory from "../../src/index.mjs"

const timestamp = "2026-10-03T00:00:00.000Z"
const sourceRevision = "a".repeat(40)
const evidenceRef = { kind: "check-output", ref: "fixture:verify-output", digest: "b".repeat(64) }
const expectedBody = {
  contractVersion: 1,
  jobId: "receipt-job",
  outcome: "complete",
  stopped: null,
  environmentId: "receipt-tree",
  sourceRevision,
  risk: { level: "low", score: 0, signals: [] },
  riskRecommendation: null,
  reviewRoles: ["Test Engineer"],
  performance: { status: "pass", findings: [], duplicates: [] },
  events: [
    ["environment:prepare", "pass"], ["context:collect", "pass"], ["evidence:before", "skip"],
    ["build", "pass"], ["verify", "pass"], ["risk:inspect", "pass"], ["review:Test Engineer", "pass"],
    ["evidence:after", "skip"], ["release:observe", "skip"], ["production:observe", "skip"],
    ["performance:measure", "skip"], ["garden:inspect", "skip"], ["environment:dispose", "pass"],
    ["learn:record", "skip"]
  ].map(([step, status]) => ({ step, status })),
  evidence: [{ step: "verify", ...evidenceRef }],
  findings: [],
  proposals: [],
  modelRoom: null,
  startedAt: timestamp,
  completedAt: timestamp
}
// Independent oracle: hash the declared expected artifact, not the generated digest.
const checksum = body => createHash("sha256").update(JSON.stringify(body)).digest("hex")
const trustedDigest = checksum(expectedBody)

async function receipt() {
  const pass = { status: "pass" }
  return factory.createFactory({ now: () => timestamp, makeId: () => "receipt-job" }).run({
    outcome: "verify synthetic receipt", sourceRevision
  }, factory.createFixtureAdapter({
    "environment:prepare": { status: "pass", data: { isolated: true, environmentId: "receipt-tree" } },
    "context:collect": pass, build: pass,
    verify: { status: "pass", evidence: [evidenceRef] },
    "risk:inspect": pass, "review:Test Engineer": pass, "environment:dispose": pass
  }))
}

test("fixed-clock/fixed-ID receipt matches the expected artifact and verifies through the public interface", async () => {
  const result = await receipt()
  assert.deepEqual(result, { ...expectedBody, receiptDigest: trustedDigest })
  assert.equal(factory.verifyFactoryReceipt(result, trustedDigest), true)
  assert.deepEqual(await receipt(), result)
})

test("a JSON serialized round trip verifies against the trusted original digest", async () => {
  const roundTrip = JSON.parse(JSON.stringify(await receipt()))
  assert.deepEqual(roundTrip, { ...expectedBody, receiptDigest: trustedDigest })
  assert.equal(factory.verifyFactoryReceipt(roundTrip, trustedDigest), true)
})

for (const [label, mutate] of [
  ["outcome", value => { value.outcome = "needs-attention" }],
  ["source revision", value => { value.sourceRevision = "c".repeat(40) }],
  ["event status", value => { value.events[4].status = "fail" }],
  ["event step", value => { value.events[4].step = "forged-verify" }],
  ["event deletion", value => { value.events.pop() }],
  ["event order", value => { value.events.reverse() }],
  ["evidence reference", value => { value.evidence[0].ref = "fixture:other-output" }],
  ["evidence digest", value => { value.evidence[0].digest = "d".repeat(64) }],
  ["evidence deletion", value => { value.evidence = [] }],
  ["job ID", value => { value.jobId = "other-job" }],
  ["completion time", value => { value.completedAt = "2026-10-04T00:00:00.000Z" }],
  ["added field", value => { value.extra = "untrusted" }],
  ["checksum", value => { value.receiptDigest = "0".repeat(64) }]
]) {
  test(`public verifier rejects mutated ${label}`, async () => {
    const original = await receipt()
    const changed = JSON.parse(JSON.stringify(original))
    mutate(changed)
    assert.equal(factory.verifyFactoryReceipt(original, trustedDigest), true)
    assert.equal(factory.verifyFactoryReceipt(changed, trustedDigest), false)
  })
}

test("rewriting the payload and checksum fails the trusted original but is not author authentication", async () => {
  const changed = JSON.parse(JSON.stringify(await receipt()))
  changed.outcome = "needs-attention"
  const { receiptDigest, ...changedBody } = changed
  changed.receiptDigest = checksum(changedBody)
  assert.notEqual(changed.receiptDigest, receiptDigest)
  assert.equal(factory.verifyFactoryReceipt(changed, trustedDigest), false)
  // Anyone can compute a new unkeyed checksum; trusting that new digest accepts the rewrite.
  assert.equal(factory.verifyFactoryReceipt(changed, changed.receiptDigest), true)
})

test("no trusted original or a malformed digest cannot produce a verification pass", async () => {
  const value = await receipt()
  for (const digest of [undefined, null, "", "wrong", "0".repeat(64), 42, {}, []]) {
    assert.equal(factory.verifyFactoryReceipt(value, digest), false)
  }
  for (const digest of [undefined, null, "", "wrong", 42, {}, []]) {
    assert.equal(factory.verifyFactoryReceipt({ ...value, receiptDigest: digest }, trustedDigest), false)
  }
})

test("malformed or unserializable receipt input returns false", async () => {
  for (const value of [undefined, null, "receipt", 42, [], {}]) {
    assert.equal(factory.verifyFactoryReceipt(value, trustedDigest), false)
  }
  const circular = await receipt()
  circular.evidence.push(circular)
  assert.equal(factory.verifyFactoryReceipt(circular, trustedDigest), false)
})
