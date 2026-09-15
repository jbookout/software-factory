import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  classifyRisk,
  createFactory,
  createFixtureAdapter,
  createScriptAdapter,
  evaluatePerformance,
  reviewsFor
} from "../src/index.mjs"

const pass = { status: "pass" }
const fixedClock = () => "2026-09-15T00:00:00.000Z"
const fixedId = () => "job-1"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const required = {
  "environment:prepare": { status: "pass", data: { isolated: true, environmentId: "test-tree" } },
  "environment:dispose": pass,
  "context:collect": pass,
  build: pass,
  verify: pass,
  "risk:inspect": pass,
  "review:Test Engineer": pass
}

test("risk routing selects only relevant specialist engineers", () => {
  const risk = classifyRisk({ changedPaths: ["db/migrations/0508.sql", "src/auth/session.mjs"] })
  assert.equal(risk.level, "critical")
  assert.deepEqual(reviewsFor(risk), [
    "Architecture Engineer",
    "Security Engineer",
    "Data Engineer",
    "Test Engineer"
  ])
})

test("the complete operating loop covers delivery, production, performance, gardening, and learning", async () => {
  const adapter = createFixtureAdapter({
    ...required,
    "review:Architecture Engineer": pass,
    "performance:measure": { status: "pass", measurements: { p95Ms: 108 } },
    "learn:record": { status: "pass", proposals: [{ title: "retain verified pattern" }] }
  })
  const job = {
    outcome: "ship a verified change",
    sourceRevision: "abc123",
    risk: { changedPaths: ["src/api/view.mjs"] },
    performance: { baseline: { p95Ms: 100 }, budgets: { p95Ms: { maxRegression: 0.1 } } }
  }

  const result = await createFactory({ now: fixedClock, makeId: fixedId }).run(job, adapter)

  assert.equal(result.outcome, "complete")
  assert.equal(result.performance.status, "pass")
  assert.equal(result.receiptDigest.length, 64)
  const steps = adapter.calls.map(({ step }) => step)
  for (const required of [
    "environment:prepare", "context:collect", "evidence:before", "build", "verify", "risk:inspect",
    "review:Architecture Engineer", "review:Test Engineer", "evidence:after",
    "release:observe", "production:observe", "performance:measure",
    "garden:inspect", "environment:dispose", "learn:record"
  ]) assert.ok(steps.includes(required), `missing ${required}`)
})

test("verification stops when a repair produces no new evidence", async () => {
  const adapter = createFixtureAdapter({
    ...required,
    verify: { status: "fail", findings: [{ rule: "imports", path: "src/a.mjs" }] },
    "repair:verification": pass
  })
  const result = await createFactory({ now: fixedClock, makeId: fixedId }).run({
    outcome: "repair imports",
    sourceRevision: "abc123"
  }, adapter)

  assert.equal(result.outcome, "needs-attention")
  assert.equal(result.stopped, "verify:stalled")
  assert.equal(adapter.calls.filter(({ step }) => step === "repair:verification").length, 1)
})

test("performance factory detects and deduplicates regressions", () => {
  const initial = evaluatePerformance({
    baseline: { p95Ms: 100, throughput: 50 },
    current: { p95Ms: 130, throughput: 49 },
    budgets: {
      p95Ms: { direction: "lower", maxRegression: 0.1 },
      throughput: { direction: "higher", maxRegression: 0.1 }
    }
  })
  const result = evaluatePerformance({
    baseline: { p95Ms: 100 },
    current: { p95Ms: 130 },
    budgets: { p95Ms: { maxRegression: 0.1 } },
    knownFingerprints: [initial.findings[0].fingerprint]
  })
  assert.equal(result.status, "fail")
  assert.equal(result.findings.length, 0)
  assert.deepEqual(result.duplicates, [initial.findings[0].fingerprint])
})

test("an outage triggers read-only incident investigation", async () => {
  const adapter = createFixtureAdapter({
    ...required,
    "production:observe": { status: "finding", findings: [{ severity: "outage", signal: "health" }] }
  })
  await createFactory({ now: fixedClock, makeId: fixedId }).run({
    outcome: "observe rollout",
    sourceRevision: "abc123"
  }, adapter)
  const incident = adapter.calls.find(({ step }) => step === "incident:investigate")
  assert.equal(incident.request.authority, "read-only")
})

test("missing verification or specialist review can never produce a green receipt", async () => {
  const missingVerification = createFixtureAdapter({
    "environment:prepare": required["environment:prepare"],
    "environment:dispose": pass,
    "context:collect": pass,
    build: pass
  })
  const first = await createFactory({ now: fixedClock, makeId: fixedId }).run({
    outcome: "verify the change",
    sourceRevision: "abc123"
  }, missingVerification)
  assert.equal(first.stopped, "verify:missing")

  const missingReview = createFixtureAdapter({ ...required, "review:Test Engineer": { status: "skip" } })
  const second = await createFactory({ now: fixedClock, makeId: fixedId }).run({
    outcome: "review the change",
    sourceRevision: "abc123"
  }, missingReview)
  assert.equal(second.stopped, "review:missing")
})

test("bug and interface work requires before-and-after evidence", async () => {
  const missingBefore = createFixtureAdapter({ ...required })
  const first = await createFactory({ now: fixedClock, makeId: fixedId }).run({
    outcome: "fix a bug",
    kind: "bug",
    sourceRevision: "abc123"
  }, missingBefore)
  assert.equal(first.stopped, "evidence:before:missing")

  const missingAfter = createFixtureAdapter({
    ...required,
    "evidence:before": pass,
    "risk:inspect": { status: "pass", data: { changedPaths: ["src/view.css"] } },
    "review:Architecture Engineer": pass,
    "review:UI and Accessibility Engineer": pass
  })
  const second = await createFactory({ now: fixedClock, makeId: fixedId }).run({
    outcome: "change the interface",
    sourceRevision: "abc123"
  }, missingAfter)
  assert.equal(second.stopped, "evidence:after:missing")
})

test("an unproven task environment fails before product work starts", async () => {
  const adapter = createFixtureAdapter({ "environment:prepare": pass })
  const result = await createFactory({ now: fixedClock, makeId: fixedId }).run({
    outcome: "work in isolation",
    sourceRevision: "abc123"
  }, adapter)
  assert.equal(result.stopped, "environment:prepare")
  assert.equal(adapter.calls.some(({ step }) => step === "build"), false)
})

test("adapter failures become evidence and still dispose the isolated environment", async () => {
  const adapter = createFixtureAdapter({
    ...required,
    "context:collect": () => { throw new TypeError("private failure detail") }
  })
  const result = await createFactory({ now: fixedClock, makeId: fixedId }).run({
    outcome: "contain adapter failure",
    sourceRevision: "abc123"
  }, adapter)
  assert.equal(result.stopped, "context:collect")
  assert.ok(result.findings.some(({ errorType, errorDigest }) => errorType === "TypeError" && errorDigest.length === 64))
  assert.ok(adapter.calls.some(({ step }) => step === "environment:dispose"))
  assert.equal(JSON.stringify(result).includes("private failure detail"), false)
})

test("risk inspection adds facts that the job author omitted", async () => {
  const adapter = createFixtureAdapter({
    ...required,
    "risk:inspect": { status: "pass", data: { changedPaths: ["db/migrations/0508.sql"] } },
    "review:Architecture Engineer": pass,
    "review:Data Engineer": pass
  })
  const result = await createFactory({ now: fixedClock, makeId: fixedId }).run({
    outcome: "inspect risk",
    sourceRevision: "abc123"
  }, adapter)
  assert.equal(result.risk.level, "high")
  assert.ok(result.reviewRoles.includes("Data Engineer"))
})

test("script adapter rejects deployment and shell-shaped command configuration", async () => {
  const deployment = createScriptAdapter({ root: ".", commands: { deploy: ["true"] } })
  await assert.rejects(() => deployment.execute("deploy", {}), /cannot execute product deployment authority/)

  const invalid = createScriptAdapter({ root: ".", commands: { verify: "npm test" } })
  await assert.rejects(() => invalid.execute("verify", {}), /argv array/)
})

test("script adapter executes an argv command without a shell", async () => {
  const adapter = createScriptAdapter({
    root,
    commands: { verify: [process.execPath, "-e", "process.stdout.write(JSON.stringify({status:'pass',evidence:[{kind:'executed'}]}))"] }
  })
  const result = await adapter.execute("verify", {})
  assert.equal(result.status, "pass")
  assert.deepEqual(result.evidence, [{ kind: "executed" }])
})

test("machine-readable scope keeps every approved capability in the first contract", async () => {
  const scope = JSON.parse(await fs.readFile(path.join(root, "factory.scope.json"), "utf8"))
  assert.deepEqual(new Set(scope.authority.product), new Set([
    "runtime", "production-data", "domain-rules", "credentials", "deploy", "rollback"
  ]))
  const ids = new Set(scope.capabilities.map(({ id }) => id))
  for (const id of [
    "isolated-task-environment", "context", "before-after-evidence", "build", "deterministic-verification",
    "specialist-review", "risk-routing", "delivery-shepherd", "production-feedback",
    "performance-factory", "incident-assistance", "codebase-gardening", "learning",
    "loop-budgets", "tamper-evident-receipt"
  ]) assert.ok(ids.has(id), `missing ${id}`)
})
