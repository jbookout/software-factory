import test from "node:test"
import assert from "node:assert/strict"
import { classifyChecks } from "../src/pr-readiness.mjs"

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40)
const run = (head = C, conclusion = "success", extra = {}) => ({ id: 1, name: "strict", head_sha: head,
  status: "completed", conclusion, app: { id: 15368 }, ...extra })
const input = changes => ({ head: C, observedHead: C, requiredChecks: [{ name: "strict", appId: 15368 }],
  checkRuns: [run()], statuses: [], ...changes })

test("A/B cancelled are superseded; only authenticated required successes on C pass", () => {
  for (const head of [A, B]) assert.equal(classifyChecks(input({ head, checkRuns: [run(head, "cancelled")] })).state, "superseded")
  const evidence = [run(A, "cancelled"), run(B, "cancelled"), run()]
  const result = classifyChecks(input({ checkRuns: evidence }))
  assert.equal(result.state, "success")
  assert.deepEqual(result.evidence, evidence, "original failed/cancelled evidence survives")
})
for (const conclusion of ["cancelled", "failure", "timed_out", "skipped", "neutral"])
  test(`current required ${conclusion} never becomes green`, () => {
    assert.equal(classifyChecks(input({ checkRuns: [run(C, conclusion)] })).state, "failure")
  })
test("a missing strict context waits, even when another context is successful", () => {
  const result = classifyChecks(input({ checkRuns: [run(C, "success", { name: "other" })] }))
  assert.equal(result.state, "pending")
  assert.deepEqual(result.missing, ["strict"])
})
for (const bad of [null, {}, "", [{ name: "strict" }], [run(C, "mystery")], [run(C, "success", { app: { id: 42 } })]])
  test(`unreadable, partial or unauthenticated provider response fails closed: ${JSON.stringify(bad)}`, () => {
    assert.notEqual(classifyChecks(input({ checkRuns: bad })).state, "success")
  })
test("pending and empty observations expose a waiting action; recovery chooses latest run without erasing old failure", () => {
  assert.equal(classifyChecks(input({ checkRuns: [] })).state, "pending")
  assert.equal(classifyChecks(input({ checkRuns: [run(C, null, { status: "in_progress" })] })).state, "pending")
  const evidence = [run(C, "failure"), run(C, "success", { id: 2 })]
  assert.equal(classifyChecks(input({ checkRuns: evidence })).state, "success")
  assert.deepEqual(classifyChecks(input({ checkRuns: evidence })).evidence, evidence)
})
test("legacy commit status is exact-head bound and required inventory cannot be empty", () => {
  const result = classifyChecks(input({ requiredChecks: [{ name: "status" }], checkRuns: [],
    statuses: [{ id: 1, context: "status", state: "success", head_sha: C }] }))
  assert.equal(result.state, "success")
  assert.equal(classifyChecks(input({ requiredChecks: [] })).state, "provider-unknown")
})
for (const [status, conclusion] of [["success", null], ["failure", null], ["completed", null],
  ["completed", "pending"], ["completed", "error"], ["in_progress", "success"], ["queued", "failure"]])
  test(`malformed CheckRun ${status}/${conclusion} is provider-unknown`, () => {
    const result = classifyChecks(input({ checkRuns: [run(C, conclusion, { status })] }))
    assert.equal(result.state, "provider-unknown")
    assert.equal(result.repairable, undefined)
  })
