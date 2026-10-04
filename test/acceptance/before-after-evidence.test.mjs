import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import * as factory from "../../src/index.mjs"

const baseRevision = "a".repeat(40)
const candidateRevision = "b".repeat(40)
const baselineBuild = "c".repeat(64)
const buildDigest = "d".repeat(64)
const criterion = { id: "note-persists", expectation: "a saved note is read back after reload" }
const job = { kind: "bug", outcome: "fix note persistence", sourceRevision: baseRevision, criterion }
const pass = { status: "pass" }
const built = { status: "pass", data: { candidateRevision, buildDigest } }
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")

// Each test gets its own evidence store outside any scratch environment.
async function store() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-evidence-"))
  async function write(ref, content) {
    const bytes = Buffer.from(content)
    await fs.writeFile(path.join(root, ref), bytes)
    return { ref, digest: sha256(bytes) }
  }
  async function observe(ref, fields = {}) {
    const artifact = await write(ref, JSON.stringify({ schema: "factory-observation.v1",
      criterionId: criterion.id, revision: candidateRevision, buildDigest, outcome: "passed",
      observed: "saved note read back after reload", attachments: [], ...fields }))
    return { kind: "observation", criterionId: criterion.id, artifact }
  }
  async function proof({ after = {}, afterShot = "after screen" } = {}) {
    const beforeShot = await write("before.png", "before screen")
    const before = await observe("before.json", { revision: baseRevision, buildDigest: baselineBuild,
      outcome: "failed", observed: "note missing after reload", attachments: [beforeShot] })
    const shot = await write("after.png", afterShot)
    const observed = await observe("after.json", { attachments: [shot], ...after })
    return { before: { status: "pass", evidence: [before] }, after: { status: "pass", evidence: [observed] } }
  }
  return { root, write, observe, proof, readArtifact: factory.createArtifactReader(root) }
}

function steps({ before, after, build = built, ...overrides }) {
  return {
    "environment:prepare": { status: "pass", data: { isolated: true, environmentId: "evidence-tree" } },
    "environment:dispose": pass,
    "context:collect": pass,
    "evidence:before": before,
    build,
    verify: pass,
    "risk:inspect": pass,
    "review:Test Engineer": pass,
    "evidence:after": after,
    ...overrides
  }
}

async function run(adapterSteps, { readArtifact, value = job } = {}) {
  const adapter = factory.createFixtureAdapter(adapterSteps)
  const result = await factory.createFactory({ readArtifact }).run(value, adapter)
  return { result, adapter }
}

function assertStopped(result, adapter, reason) {
  assert.equal(result.outcome, "needs-attention")
  assert.equal(result.stopped, reason)
  assert.equal(adapter.calls.filter(call => call.step === "release:observe").length, 0)
}

test("an independently read correct artifact passes", async () => {
  const s = await store()
  const { result, adapter } = await run(steps(await s.proof()), s)
  assert.equal(result.outcome, "complete")
  assert.equal(result.stopped, null)
  assert.deepEqual(result.candidate, { revision: candidateRevision, buildDigest })
  assert.equal(result.evidenceAcceptance.before.result, "passed")
  assert.equal(result.evidenceAcceptance.after.result, "passed")
  assert.deepEqual(result.evidenceAcceptance.after.reasons, [])
  assert.deepEqual(result.evidenceAcceptance.after.artifacts.map(item => item.ref), ["after.json", "after.png"])
  const after = adapter.calls.find(call => call.step === "evidence:after").request
  assert.deepEqual(after.criterion, criterion)
  assert.deepEqual(after.candidate, result.candidate)
})

test("a no-op builder fails regardless of its pass label", async t => {
  const s = await store()
  const evidence = await s.proof()
  for (const [label, build, reason] of [
    ["no build identity", pass, "build:unbound"],
    ["malformed build digest", { status: "pass", data: { candidateRevision, buildDigest: "x" } }, "build:unbound"],
    ["unchanged revision", { status: "pass", data: { candidateRevision: baseRevision, buildDigest } }, "build:no-change"]
  ]) {
    await t.test(label, async () => {
      const { result, adapter } = await run(steps({ ...evidence, build }), s)
      assertStopped(result, adapter, reason)
      assert.equal(result.candidate, null)
      assert.equal(adapter.calls.some(call => call.step === "verify"), false)
      assert.equal(adapter.calls.some(call => call.step === "evidence:after"), false)
    })
  }

  await t.test("a builder whose candidate still shows the defect", async () => {
    const unchanged = await s.proof({ after: { outcome: "failed", observed: "note missing after reload" } })
    const { result, adapter } = await run(steps(unchanged), s)
    assertStopped(result, adapter, "evidence:after:failed")
  })
})

test("empty evidence fails", async t => {
  const s = await store()
  const evidence = await s.proof()
  await t.test("before", async () => {
    const { result, adapter } = await run(steps({ ...evidence, before: pass }), s)
    assertStopped(result, adapter, "evidence:before:failed")
    assert.equal(adapter.calls.some(call => call.step === "build"), false)
  })
  await t.test("after", async () => {
    const { result, adapter } = await run(steps({ ...evidence, after: { status: "pass", evidence: [] } }), s)
    assertStopped(result, adapter, "evidence:after:failed")
    assert.match(result.evidenceAcceptance.after.reasons[0], /no after evidence/)
  })
  await t.test("an empty artifact", async () => {
    const empty = { kind: "observation", criterionId: criterion.id, artifact: await s.write("empty.json", "") }
    const { result, adapter } = await run(steps({ ...evidence, after: { status: "pass", evidence: [empty] } }), s)
    assertStopped(result, adapter, "evidence:after:failed")
  })
})

test("empty successful stdout fails instead of passing", async () => {
  const adapter = factory.createScriptAdapter({ root: process.cwd(), commands: {
    "evidence:after": [process.execPath, "-e", "process.exit(0)"]
  } })
  await assert.rejects(adapter.execute("evidence:after", {}), /emitted no result/)
})

test("malformed evidence is rejected rather than silently dropped", async () => {
  const adapter = factory.createFixtureAdapter({ "evidence:after": { status: "pass", evidence: "after.png" } })
  await assert.rejects(adapter.execute("evidence:after", {}), /evidence/)
})

test("a stale screenshot fails", async t => {
  const s = await store()
  for (const [label, options] of [
    ["copied from the baseline capture", { afterShot: "before screen" }],
    ["observed on the baseline revision", { after: { revision: baseRevision } }],
    ["observed on another build of the candidate revision", { after: { buildDigest: baselineBuild } }]
  ]) {
    await t.test(label, async () => {
      const { result, adapter } = await run(steps(await s.proof(options)), s)
      assertStopped(result, adapter, "evidence:after:failed")
    })
  }
})

test("a forged pass fails", async t => {
  const s = await store()

  await t.test("the label says pass but the artifact observed failure", async () => {
    const forged = await s.proof({ after: { outcome: "failed", observed: "note missing after reload" } })
    const { result, adapter } = await run(steps(forged), s)
    assertStopped(result, adapter, "evidence:after:failed")
    assert.match(result.evidenceAcceptance.after.reasons.join("\n"), /observed failed, expected passed/)
  })

  await t.test("the artifact bytes changed after the digest was recorded", async () => {
    const forged = await s.proof()
    await s.write("after.png", "edited after capture")
    const { result, adapter } = await run(steps(forged), s)
    assertStopped(result, adapter, "evidence:after:failed")
    assert.match(result.evidenceAcceptance.after.reasons.join("\n"), /digest mismatch: after\.png/)
  })

  await t.test("the only evidence proves a different criterion", async () => {
    const evidence = await s.proof()
    const other = { ...evidence.after.evidence[0], criterionId: "unrelated" }
    const { result, adapter } = await run(steps({ ...evidence, after: { status: "pass", evidence: [other] } }), s)
    assertStopped(result, adapter, "evidence:after:failed")
  })

  await t.test("the artifact path escapes the evidence store", async () => {
    const evidence = await s.proof()
    const escaped = { ...evidence.after.evidence[0],
      artifact: { ...evidence.after.evidence[0].artifact, ref: "../after.json" } }
    const { result, adapter } = await run(steps({ ...evidence, after: { status: "pass", evidence: [escaped] } }), s)
    assertStopped(result, adapter, "evidence:after:failed")
  })

  await t.test("no artifact reader is configured", async () => {
    const { result, adapter } = await run(steps(await s.proof()))
    assertStopped(result, adapter, "evidence:before:blocked")
    assert.equal(result.evidenceAcceptance.before.result, "blocked")
  })

  await t.test("the referenced artifact is absent", async () => {
    const evidence = await s.proof()
    await fs.rename(path.join(s.root, "after.json"), path.join(s.root, "moved.json"))
    const { result, adapter } = await run(steps(evidence), s)
    assertStopped(result, adapter, "evidence:after:blocked")
  })

  await t.test("the observer itself was blocked", async () => {
    const { result, adapter } = await run(steps(await s.proof({ after: { outcome: "blocked" } })), s)
    assertStopped(result, adapter, "evidence:after:blocked")
  })
})

test("an already-passing baseline cannot prove a repair", async () => {
  const s = await store()
  const evidence = await s.proof()
  const passing = await s.observe("baseline.json", { revision: baseRevision, buildDigest: baselineBuild })
  const { result, adapter } = await run(steps({ ...evidence, before: { status: "pass", evidence: [passing] } }), s)
  assertStopped(result, adapter, "evidence:before:failed")
  assert.equal(adapter.calls.some(call => call.step === "build"), false)
})

test("interface work found by inspection must prove its baseline too", async () => {
  const s = await store()
  const evidence = await s.proof()
  const { result, adapter } = await run(steps({ ...evidence, before: pass,
    "risk:inspect": { status: "pass", data: { changedPaths: ["src/view.css"] } },
    "review:UI and Accessibility Engineer": pass }), { ...s, value: { ...job, kind: "feature" } })
  assertStopped(result, adapter, "evidence:before:failed")

  const proven = await run(steps({ ...evidence,
    "risk:inspect": { status: "pass", data: { changedPaths: ["src/view.css"] } },
    "review:UI and Accessibility Engineer": pass }), { ...s, value: { ...job, kind: "feature" } })
  assert.equal(proven.result.outcome, "complete")
})

test("evidence work needs a frozen criterion before any product work", async () => {
  const s = await store()
  const { criterion: omitted, ...unframed } = job
  const { result, adapter } = await run(steps(await s.proof()), { ...s, value: unframed })
  assertStopped(result, adapter, "evidence:criterion:missing")
  assert.equal(adapter.calls.some(call => call.step === "evidence:before"), false)
  assert.equal(adapter.calls.some(call => call.step === "build"), false)

  for (const malformed of [{ id: "" , expectation: "x" }, { id: "x" }, { ...criterion, extra: true }]) {
    const rejected = factory.createFixtureAdapter(steps(await s.proof()))
    await assert.rejects(factory.createFactory({ readArtifact: s.readArtifact }).run({ ...job, criterion: malformed }, rejected),
      /criterion/)
    assert.deepEqual(rejected.calls, [])
  }
})
