import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

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

async function run(adapterSteps, { readArtifact, value = job, evidenceLimits } = {}) {
  const adapter = factory.createFixtureAdapter(adapterSteps)
  const result = await factory.createFactory({ readArtifact, evidenceLimits }).run(value, adapter)
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

test("review 2: adapters cannot rewrite the frozen criterion or candidate", async t => {
  for (const phase of ["before", "after"]) await t.test(phase, async () => {
    const s = await store()
    const proof = await s.proof()
    const value = structuredClone(job)
    const { result, adapter } = await run(steps({ ...proof,
      [`evidence:${phase}`]: async request => {
        if (phase === "before") {
          request.criterion.id = "unrelated"
          request.criterion.expectation = "unrelated behavior"
          const observation = await s.observe("mutated-before.json", { criterionId: "unrelated",
            revision: baseRevision, outcome: "failed" })
          return { status: "pass", evidence: [{ ...observation, criterionId: "unrelated" }] }
        }
        request.candidate.revision = baseRevision
        return { status: "pass", evidence: [await s.observe("mutated-after.json", { revision: baseRevision })] }
      } }), { ...s, value })
    assertStopped(result, adapter, `evidence:${phase}:failed`)
    assert.deepEqual(value.criterion, criterion)
    if (phase === "after") assert.equal(result.candidate.revision, candidateRevision)
  })
})

test("review 2: asynchronous reads retain independent acceptance bindings", async () => {
  const s = await store()
  const proof = await s.proof()
  const value = structuredClone(job)
  let afterRequest
  const { result } = await run(steps({ ...proof, "evidence:after": request => {
    afterRequest = request
    return proof.after
  } }), { value, readArtifact: async ref => {
    if (ref === "after.json") {
      value.criterion.id = "late-change"
      afterRequest.candidate.revision = baseRevision
      await Promise.resolve()
    }
    return s.readArtifact(ref)
  } })
  assert.equal(result.outcome, "complete")
  assert.equal(result.candidate.revision, candidateRevision)
})

test("review 3: both repair paths rebuild and reject evidence for the initial candidate", async t => {
  for (const phase of ["verification", "review"]) await t.test(phase, async () => {
    const s = await store()
    const proof = await s.proof()
    const final = { revision: "c".repeat(40), buildDigest: "e".repeat(64) }
    let builds = 0
    let repaired = false
    const check = phase === "verification" ? "verify" : "review:Test Engineer"
    const setup = steps({ ...proof,
      build: () => ++builds === 1 ? built : { status: "pass", data: {
        candidateRevision: final.revision, buildDigest: final.buildDigest } },
      [check]: ({ round }) => round === 1 ? { status: "fail", findings: [{ reason: "repair this" }] } : pass,
      [`repair:${phase}`]: () => { repaired = true; return { status: "pass", data: {
        sourceChanged: true, candidateRevision: final.revision, buildDigest: final.buildDigest } } }
    })
    const { result, adapter } = await run(setup, s)
    assertStopped(result, adapter, "evidence:after:failed")
    assert.equal(repaired, true)
    assert.equal(builds, 2)
    assert.deepEqual(result.candidate, final)
    if (phase === "review") {
      const repairIndex = adapter.calls.findIndex(call => call.step === "repair:review")
      assert.ok(adapter.calls.slice(repairIndex + 1).some(call => call.step === "verify"))
    }
    builds = 0
    setup["evidence:after"] = { status: "pass", evidence: [await s.observe("final.json", final)] }
    const accepted = await run(setup, s)
    assert.equal(accepted.result.outcome, "complete")
    assert.deepEqual(accepted.result.candidate, final)
  })
})

test("review 4: filesystem reader rejects leaf and parent symlinks", async t => {
  const s = await store()
  const outside = await store()
  await outside.write("outside.txt", "outside bytes")
  await fs.symlink(path.join(outside.root, "outside.txt"), path.join(s.root, "leaf"))
  await fs.symlink(outside.root, path.join(s.root, "parent"))
  for (const ref of ["leaf", "parent/outside.txt"]) await t.test(ref, async () => {
    assert.equal(await s.readArtifact(ref), null)
  })
})

test("review 5: stalled artifact reader times out with disposal and a typed verdict", async () => {
  const s = await store()
  const pending = run(steps(await s.proof()), { readArtifact: () => new Promise(() => {}),
    evidenceLimits: { timeoutMs: 30 } })
  let timer
  try {
    const { result, adapter } = await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("acceptance never reached cleanup")), 500)
    })])
    assertStopped(result, adapter, "evidence:before:blocked")
    assert.match(result.evidenceAcceptance.before.reasons.join("\n"), /deadline/)
    assert.equal(adapter.calls.filter(call => call.step === "environment:dispose").length, 1)
  } finally { clearTimeout(timer) }
})

test("review 5: filesystem reader rejects a FIFO without waiting for a writer", async () => {
  const s = await store()
  await promisify(execFile)("mkfifo", [path.join(s.root, "pipe")])
  const moduleUrl = new URL("../../src/evidence.mjs", import.meta.url).href
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
    `import { createArtifactReader } from ${JSON.stringify(moduleUrl)};
     console.log(await createArtifactReader(${JSON.stringify(s.root)})("pipe"));`], { timeout: 5000 })
  assert.equal(stdout.trim(), "null")
})

test("review 5: file and injected reader byte limits reject oversized artifacts", async t => {
  const s = await store()
  await s.write("large.bin", "x".repeat(2048))
  await t.test("filesystem", async () => {
    assert.equal(await factory.createArtifactReader(s.root, { maxBytes: 1024 })("large.bin"), null)
  })
  await t.test("acceptance", async () => {
    const { result, adapter } = await run(steps(await s.proof()), {
      readArtifact: () => Buffer.alloc(2048), evidenceLimits: { maxBytes: 1024 } })
    assertStopped(result, adapter, "evidence:before:failed")
    assert.match(result.evidenceAcceptance.before.reasons.join("\n"), /size limit/)
  })
})

test("review 6: malformed reader bytes fail with receipt and disposal", async t => {
  for (const bytes of [{ length: 1 }, "partial text", new Uint8Array([1])]) await t.test(String(bytes), async () => {
    const s = await store()
    const { result, adapter } = await run(steps(await s.proof()), { readArtifact: () => bytes })
    assertStopped(result, adapter, "evidence:before:failed")
    assert.match(result.evidenceAcceptance.before.reasons.join("\n"), /byte contract/)
    assert.equal(adapter.calls.filter(call => call.step === "environment:dispose").length, 1)
    assert.equal(factory.verifyFactoryReceipt(result, result.receiptDigest), true)
  })
})

test("review 6: unexpected acceptance errors still produce a receipt and dispose", async () => {
  const s = await store()
  const proof = await s.proof()
  let reads = 0
  const record = { kind: "observation", criterionId: criterion.id,
    get artifact() {
      if (++reads > 1) throw Error("unexpected acceptance error")
      return proof.before.evidence[0].artifact
    } }
  const { result, adapter } = await run(steps({ ...proof, before: { status: "pass", evidence: [record] } }), s)
  assertStopped(result, adapter, "evidence:before:failed")
  assert.equal(adapter.calls.filter(call => call.step === "environment:dispose").length, 1)
  assert.equal(factory.verifyFactoryReceipt(result, result.receiptDigest), true)
})

test("review 7: feature and refactor interface baselines may already pass", async t => {
  for (const kind of ["feature", "refactor"]) for (const inspected of [false, true]) {
    await t.test(`${kind}, ${inspected ? "inspected" : "declared"}`, async () => {
      const s = await store()
      const proof = await s.proof()
      const passing = await s.observe("healthy-baseline.json", { revision: baseRevision, buildDigest: baselineBuild })
      const { result } = await run(steps({ ...proof, before: { status: "pass", evidence: [passing] },
        "risk:inspect": inspected ? { status: "pass", data: { signals: ["interface"] } } : pass,
        "review:UI and Accessibility Engineer": pass }), { ...s, value: { ...job, kind,
        risk: inspected ? {} : { signals: ["interface"] } } })
      assert.equal(result.outcome, "complete")
      assert.equal(result.evidenceAcceptance.before.result, "passed")
    })
  }
})

test("review 8: a filename beginning with two dots is contained and readable", async () => {
  const s = await store()
  await s.write("..capture.json", "capture bytes")
  assert.deepEqual(await s.readArtifact("..capture.json"), Buffer.from("capture bytes"))
})

test("filesystem reads retain exact binary bytes and the pinned root identity", async () => {
  const s = await store()
  await fs.mkdir(path.join(s.root, "nested"))
  const bytes = Buffer.from([0, 255, 128, 10, 13])
  await fs.writeFile(path.join(s.root, "nested", "binary"), bytes)
  assert.deepEqual(await s.readArtifact("nested/./binary"), bytes)
  assert.equal(await s.readArtifact("nested"), null)
  assert.equal(await s.readArtifact("../binary"), null)
  const outside = await store()
  await outside.write("nested", "outside bytes")
  await fs.rename(s.root, `${s.root}-moved`)
  await fs.symlink(outside.root, s.root)
  assert.equal(await s.readArtifact("nested"), null)
})

test("descriptor-relative traversal survives a parent swapped for an outside symlink", async () => {
  const s = await store()
  const outside = await store()
  await fs.mkdir(path.join(s.root, "parent"))
  await s.write("parent/capture", "inside")
  await outside.write("capture", "outside")
  const helper = new URL("../../src/read-artifact.py", import.meta.url)
  const request = { root: await fs.realpath(s.root), ref: "parent/capture", max_bytes: 1024 }
  const rootStat = await fs.stat(s.root)
  request.device = rootStat.dev
  request.inode = rootStat.ino
  const { stdout } = await promisify(execFile)("python3", ["-B", "-c", `
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("reader", ${JSON.stringify(helper.pathname)})
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
original = os.open
def swap_after_open(path, flags, **kwargs):
    descriptor = original(path, flags, **kwargs)
    if path == "parent":
        os.rename(${JSON.stringify(path.join(s.root, "parent"))}, ${JSON.stringify(path.join(s.root, "moved"))})
        os.symlink(${JSON.stringify(outside.root)}, ${JSON.stringify(path.join(s.root, "parent"))})
    return descriptor
os.open = swap_after_open
print(json.dumps(reader.read_artifact(json.loads(${JSON.stringify(JSON.stringify(request))}))))
`], { timeout: 5000 })
  assert.deepEqual(Buffer.from(JSON.parse(stdout), "base64"), Buffer.from("inside"))
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
