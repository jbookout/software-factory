import assert from "node:assert/strict"
import test from "node:test"

import { createFactory, createFixtureAdapter } from "../../src/index.mjs"

const job = { outcome: "bound synthetic repairs", sourceRevision: "a".repeat(40) }
const pass = { status: "pass" }
const ready = {
  "environment:prepare": { status: "pass", data: { isolated: true, environmentId: "budget-tree" } },
  "environment:dispose": pass,
  "context:collect": pass,
  build: pass,
  verify: pass,
  "risk:inspect": pass,
  "review:Test Engineer": pass,
  "repair:verification": pass,
  "repair:review": pass
}
const phases = [
  { step: "verify", repair: "repair:verification", stopped: "verify", field: "verificationRounds", limit: 3 },
  { step: "review:Test Engineer", repair: "repair:review", stopped: "review", field: "reviewRounds", limit: 2 }
]
const callsFor = (adapter, step) => adapter.calls.filter(call => call.step === step)
const changingFailure = ({ round }) => ({ status: "fail", findings: [{ reason: `defect ${round}` }] })

function assertStopped(result, adapter, reason) {
  assert.equal(result.outcome, "needs-attention")
  assert.equal(result.stopped, reason)
  assert.equal(callsFor(adapter, "release:observe").length, 0)
  assert.equal(callsFor(adapter, "environment:dispose").length, 1)
  assert.equal(callsFor(adapter, "learn:record").length, 1)
}

for (const phase of phases) {
  test(`${phase.stopped}: changing failures exhaust the default budget with no final repair`, async () => {
    const adapter = createFixtureAdapter({ ...ready, [phase.step]: changingFailure })
    const result = await createFactory().run(job, adapter)
    assertStopped(result, adapter, `${phase.stopped}:budget-exhausted`)
    assert.deepEqual(callsFor(adapter, phase.step).map(call => call.request.round),
      Array.from({ length: phase.limit }, (_, index) => index + 1))
    assert.deepEqual(callsFor(adapter, phase.repair).map(call => call.request.round),
      Array.from({ length: phase.limit - 1 }, (_, index) => index + 1))
    if (phase.stopped === "verify") assert.equal(callsFor(adapter, "risk:inspect").length, 0)
  })

  test(`${phase.stopped}: repeated findings stop on the first repeated round`, async () => {
    const adapter = createFixtureAdapter({
      ...ready, [phase.step]: { status: "fail", findings: [{ reason: "unchanged defect" }] }
    })
    const result = await createFactory().run(job, adapter)
    assertStopped(result, adapter, `${phase.stopped}:stalled`)
    assert.equal(callsFor(adapter, phase.step).length, 2)
    assert.equal(callsFor(adapter, phase.repair).length, 1)
  })

  test(`${phase.stopped}: a missing check stops immediately without repair`, async () => {
    const steps = { ...ready }
    delete steps[phase.step]
    const adapter = createFixtureAdapter(steps)
    const result = await createFactory().run(job, adapter)
    assertStopped(result, adapter, `${phase.stopped}:missing`)
    assert.equal(callsFor(adapter, phase.step).length, 1)
    assert.equal(callsFor(adapter, phase.repair).length, 0)
  })

  test(`${phase.stopped}: a missing repair stops before another check`, async () => {
    const steps = { ...ready, [phase.step]: changingFailure }
    delete steps[phase.repair]
    const adapter = createFixtureAdapter(steps)
    const result = await createFactory().run(job, adapter)
    assertStopped(result, adapter, `${phase.repair}:missing`)
    assert.equal(callsFor(adapter, phase.step).length, 1)
    assert.equal(callsFor(adapter, phase.repair).length, 1)
  })

  test(`${phase.stopped}: a final-round pass completes without a final repair`, async () => {
    const adapter = createFixtureAdapter({ ...ready,
      [phase.step]: request => request.round === phase.limit ? pass : changingFailure(request) })
    const result = await createFactory().run(job, adapter)
    assert.equal(result.outcome, "complete")
    assert.equal(result.stopped, null)
    assert.equal(callsFor(adapter, phase.step).length, phase.limit)
    assert.equal(callsFor(adapter, phase.repair).length, phase.limit - 1)
    assert.equal(callsFor(adapter, "release:observe").length, 1)
  })

  for (const limit of [1, 4, 10]) {
    test(`${phase.stopped}: explicit budget ${limit} bounds changing failures`, async () => {
      const adapter = createFixtureAdapter({ ...ready, [phase.step]: changingFailure })
      const result = await createFactory().run({ ...job, budgets: { [phase.field]: limit } }, adapter)
      assertStopped(result, adapter, `${phase.stopped}:budget-exhausted`)
      assert.equal(callsFor(adapter, phase.step).length, limit)
      assert.equal(callsFor(adapter, phase.repair).length, limit - 1)
    })
  }

  for (const [label, value] of [
    ["zero", 0], ["negative", -1], ["fraction", 1.5], ["over maximum", 11],
    ["NaN", NaN], ["infinity", Infinity], ["string", "2"], ["null", null],
    ["undefined", undefined], ["boolean", true]
  ]) {
    test(`${phase.stopped}: rejects ${label} budget before any work`, async () => {
      const adapter = createFixtureAdapter(ready)
      let clockCalls = 0
      let idCalls = 0
      const factory = createFactory({ now: () => { clockCalls++; return "fixed" },
        makeId: () => { idCalls++; return "fixed" } })
      await assert.rejects(factory.run({ ...job, budgets: { [phase.field]: value } }, adapter), /budgets/)
      assert.deepEqual(adapter.calls, [])
      assert.equal(clockCalls, 0)
      assert.equal(idCalls, 0)
    })
  }
}

for (const [label, budgets] of [
  ["null", null], ["array", []], ["string", "2"], ["number", 2],
  ["unknown field", { repairRounds: 2 }]
]) {
  test(`rejects ${label} budgets before adapter work`, async () => {
    const adapter = createFixtureAdapter(ready)
    await assert.rejects(createFactory().run({ ...job, budgets }, adapter), /budgets/)
    assert.deepEqual(adapter.calls, [])
  })
}

test("an empty budget object preserves both default exhaustion limits", async () => {
  const adapter = createFixtureAdapter({ ...ready, verify: request => request.round === 3 ? pass : changingFailure(request),
    "review:Test Engineer": changingFailure })
  const result = await createFactory().run({ ...job, budgets: {} }, adapter)
  assertStopped(result, adapter, "review:budget-exhausted")
  assert.equal(callsFor(adapter, "verify").length, 3)
  assert.equal(callsFor(adapter, "review:Test Engineer").length, 2)
})

test("each specialist shares the review-round budget and a missing specialist stops repair", async () => {
  const adapter = createFixtureAdapter({ ...ready,
    "review:Architecture Engineer": changingFailure, "review:Test Engineer": changingFailure })
  const result = await createFactory().run({ ...job, risk: { signals: ["contract"] } }, adapter)
  assertStopped(result, adapter, "review:budget-exhausted")
  for (const role of result.reviewRoles) assert.equal(callsFor(adapter, `review:${role}`).length, 2)
  assert.equal(callsFor(adapter, "repair:review").length, 1)

  const missing = createFixtureAdapter({ ...ready, "review:Test Engineer": changingFailure })
  const second = await createFactory().run({ ...job, risk: { signals: ["contract"] } }, missing)
  assertStopped(second, missing, "review:missing")
  assert.equal(callsFor(missing, "review:Test Engineer").length, 1)
  assert.equal(callsFor(missing, "repair:review").length, 0)
})
