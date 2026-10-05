import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"
import os from "node:os"
import path from "node:path"
import * as modelRoom from "../src/model-room.mjs"

import { createPinnedBuildContext, readPinnedContract, routeDoctorCreBuild,
  selectOptionalBuildContext, verifyPinnedBuildContext, signEvaluationBundle } from "../src/model-room.mjs"
import { createCodexBuildArgs, createCodexBuildPrompt } from "../src/codex-build.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))

const baseline = { provider: "codex", model: "gpt-5.6-sol", effort: "high" }
const candidate = { provider: "claude", model: "claude-opus-5", effort: "high" }
const routeKey = "claude/claude-opus-5/high"
const excerpt = "Overall status is available, partial or unavailable. Per-item judged.calibration_status is unverified_model_output."
const contract = { source_revision: "a".repeat(40), path: "mcp-server/src/jev-needs-joe-advisory.js",
  content_digest: `sha256:${createHash("sha256").update(excerpt).digest("hex")}`, excerpt }
const common = { task: "Implement the DoctorCRE Needs Joe advisory model from the pinned CARR contract.",
  contracts: [contract], baseline, candidates: [candidate], verifyObservation: row => row.attested === true }

function jev(choice = routeKey) {
  return async (_, request) => {
    const sent = JSON.parse(request.body)
    assert.equal(sent.state.contracts[0].excerpt, contract.excerpt)
    return { ok: true, async json() { return { model: "jev-1.13.0", answers: { preferred_route: {
      type: "choice", choice, confidence: 0.8,
      probabilities: { baseline: choice === "baseline" ? 0.8 : 0.2, [routeKey]: choice === routeKey ? 0.8 : 0.2 }
    } } } } }
  }
}

test("Codex attended build uses the approval preset without a conflicting sandbox flag", () => {
  const args = createCodexBuildArgs({ route: baseline }, "/tmp/result.json")
  assert.ok(args.includes("--approve-for-me"))
  assert.ok(!args.includes("-s"))
  assert.ok(!args.includes("--sandbox"))
})

test("Codex build response schema closes every object shape", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../schemas/factory-build-result.schema.json", import.meta.url)))
  const seen = new Set()
  function inspect(node) {
    if (!node || typeof node !== "object" || seen.has(node)) return
    seen.add(node)
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false)
      assert.deepEqual(new Set(node.required ?? []), new Set(Object.keys(node.properties ?? {})))
    }
    for (const value of Object.values(node)) inspect(value)
  }
  inspect(schema)
})

function observation(id, overrides = {}) {
  return { case_id: id, route_key: routeKey, oracle_status: "pass", repository_status: "pass",
    model_readback: "claude-opus-5", source_base: "c".repeat(40),
    oracle_digest: `sha256:${"d".repeat(64)}`, attested: true, ...overrides }
}

test("Jev sees exact pinned contract but cannot promote insufficient replay cases", async () => {
  const result = await routeDoctorCreBuild({ ...common, observations: [observation("pr44"), observation("pr45")],
    controlEnabled: true, apiKey: "test", fetchImpl: jev() })
  assert.deepEqual(result.selected_route, baseline)
  assert.equal(result.jev.status, "skipped")
  assert.equal(result.jev.reason, "single_qualified_route")
  assert.deepEqual(result.eligible_routes, [])
  assert.equal(result.qualifications[0].checked_cases, 2)
})

for (const [name, observations, checkedCases] of [
  ["failed oracle", [observation("pr44", { oracle_status: "fail" }), observation("pr45"),
    observation("pr46"), observation("pr47")], 0],
  ["duplicate case", [observation("pr44"), observation("pr45"), observation("pr45")], 2],
  ["unverified case", [observation("pr44"), observation("pr45"),
    observation("pr46", { attested: false })], 2]
]) {
  test(`${name} cannot promote a candidate under explicit control`, async () => {
    const result = await routeDoctorCreBuild({ ...common, observations,
      controlEnabled: true, verifyControl: () => true, apiKey: "test", fetchImpl: jev() })
    assert.deepEqual(result.selected_route, baseline)
    assert.equal(result.qualifications[0].checked_cases, checkedCases)
    assert.deepEqual(result.eligible_routes, [])
    assert.equal(result.jev.reason, "single_qualified_route")
  })
}

test("three distinct authenticated passes permit explicit control", async () => {
  const observations = [observation("pr44"), observation("pr45"), observation("pr46")]
  const result = await routeDoctorCreBuild({ ...common, observations,
    controlEnabled: true, verifyControl: () => true, apiKey: "test", fetchImpl: jev() })
  assert.deepEqual(result.selected_route, candidate)
  assert.equal(result.selection_reason, "qualified_jev_choice")
  const shadow = await routeDoctorCreBuild({ ...common, observations,
    apiKey: "test", fetchImpl: jev() })
  assert.deepEqual(shadow.selected_route, baseline)
  const unapproved = await routeDoctorCreBuild({ ...common, observations,
    controlEnabled: true, apiKey: "test", fetchImpl: jev() })
  assert.deepEqual(unapproved.selected_route, baseline)
  assert.equal(unapproved.selection_reason, "qualified_control_ready")
})

test("Jev failure or invalid answer keeps baseline route explicit", async () => {
  const failed = await routeDoctorCreBuild({ ...common, apiKey: "test", fetchImpl: async () => { throw Error("down") } })
  assert.deepEqual(failed.selected_route, baseline)
  assert.equal(failed.jev.status, "unavailable")
  const invalid = await routeDoctorCreBuild({ ...common, apiKey: "test", fetchImpl: async () => ({ ok: true,
    async json() { return { model: "jev-1.13.0", answers: { preferred_route: { type: "choice", choice: "other" } } } } }) })
  assert.deepEqual(invalid.selected_route, baseline)
  assert.equal(invalid.jev.reason, "invalid_answer")
})

test("pinned contract loader reads only an exact committed source excerpt", async () => {
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  const result = await readPinnedContract({ root, sourceRevision, path: "README.md", startLine: 1, endLine: 1 })
  assert.equal(result.excerpt, "# Software Factory")
  assert.equal(result.source_revision, sourceRevision)
  await assert.rejects(readPinnedContract({ root, sourceRevision, path: "../secret", startLine: 1, endLine: 1 }))
})

test("build context retains exact source text and rejects a changed excerpt", () => {
  const context = createPinnedBuildContext([contract])
  assert.equal(verifyPinnedBuildContext(context), true)
  assert.equal(context.contracts[0].excerpt, excerpt)
  assert.equal(verifyPinnedBuildContext({ ...context, contracts: [{ ...contract, excerpt: "changed" }] }), false)
})

test("production Codex caller binds route, task, revision and pinned context", () => {
  const prompt = createCodexBuildPrompt({ route: baseline, outcome: common.task,
    sourceRevision: "e".repeat(40), pinnedBuildContext: createPinnedBuildContext([contract]) })
  assert.match(prompt, /Implement the attended DoctorCRE build task/)
  assert.match(prompt, new RegExp(contract.content_digest))
  assert.match(prompt, new RegExp(contract.excerpt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.throws(() => createCodexBuildPrompt({ route: candidate, outcome: common.task,
    sourceRevision: "e".repeat(40), pinnedBuildContext: createPinnedBuildContext([contract]) }),
  /invalid Codex build request/)
})

test("unavailable or malformed Jev hides optional context without hiding required contracts", async () => {
  const unavailable = await selectOptionalBuildContext({ task: common.task, chunks: [contract] })
  assert.equal(unavailable.reason, "no_api_key")
  assert.deepEqual(unavailable.contracts, [])
  const malformed = await selectOptionalBuildContext({ task: common.task, chunks: [contract],
    apiKey: "test", fetchImpl: async () => ({ ok: true, async json() {
      return { model: "jev-1.13.0", answers: { context_0: { type: "choice", choice: "full" } } }
    } }) })
  assert.equal(malformed.reason, "invalid_answer")
  assert.deepEqual(malformed.contracts, [])
  assert.equal(createPinnedBuildContext([contract, ...malformed.contracts]).contracts[0].excerpt,
    contract.excerpt)
})


test("build preparation reads required contracts in policy order and projects a receipt", async () => {
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  const advice = await modelRoom.prepareModelRoomBuild({ task: common.task, baseDir: root,
    policy: { contracts: [
      { root: ".", sourceRevision, path: "README.md", startLine: 1, endLine: 1 },
      { root: ".", sourceRevision, path: "AGENTS.md", startLine: 1, endLine: 1 }
    ], baseline, candidates: [candidate], controlMode: "qualified_only" } })
  assert.deepEqual(advice.build_context.contracts.map(c => c.excerpt), ["# Software Factory", "# AGENTS.md"])
  assert.deepEqual(advice.selected_route, baseline)
  assert.equal(advice.qualification_evidence.reason, "not_configured")
  assert.equal(advice.context_selection.reason, "no_optional_context")
  const receipt = modelRoom.modelRoomReceipt(advice)
  assert.equal(receipt.build_context, undefined)
  assert.equal(receipt.context_selection.contracts, undefined)
  assert.equal(JSON.stringify(receipt).includes("# Software Factory"), false)
})


function preparationFixture(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-room-preparation-"))
  t.after(() => fs.renameSync(baseDir, `${baseDir}_to_delete`))
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args],
    { cwd: baseDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "-q")
  fs.writeFileSync(path.join(baseDir, "required.txt"), excerpt)
  fs.writeFileSync(path.join(baseDir, "optional.txt"), "a".repeat(4000))
  git("add", "required.txt", "optional.txt")
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture")
  const sourceRevision = git("rev-parse", "HEAD")
  const reference = file => ({ root: ".", sourceRevision, path: file, startLine: 1, endLine: 1 })
  return { baseDir, policy: { contracts: [reference("required.txt")], baseline,
    candidates: [candidate], controlMode: "qualified_only" }, optional: reference("optional.txt") }
}

test("preparation authenticates qualification and refuses tampered or unavailable evidence", async t => {
  const { baseDir, policy } = preparationFixture(t)
  policy.evaluationBundle = "evaluation.json"
  const key = "synthetic-fixture-material-".repeat(2)
  const bundle = signEvaluationBundle({ control: { task_class: "doctorcre-build",
    mode: "qualified_only", minimum_cases: 3 },
    observations: [observation("one"), observation("two"), observation("three")] }, key)
  const file = path.join(baseDir, policy.evaluationBundle)
  fs.writeFileSync(file, JSON.stringify(bundle))
  const input = { task: common.task, policy, baseDir, apiKey: "test", evaluationKey: key, fetchImpl: jev() }
  const result = await modelRoom.prepareModelRoomBuild(input)
  assert.deepEqual(result.selected_route, candidate)
  assert.equal(result.selection_reason, "qualified_jev_choice")
  assert.equal(result.qualification_evidence.status, "authenticated")
  assert.match(result.qualification_evidence.bundle_digest, /^sha256:[0-9a-f]{64}$/)
  const shadow = await modelRoom.prepareModelRoomBuild({ ...input, policy: { ...policy, controlMode: "shadow" } })
  assert.deepEqual(shadow.selected_route, baseline)
  bundle.observations[0].oracle_status = "fail"
  fs.writeFileSync(file, JSON.stringify(bundle))
  const tampered = await modelRoom.prepareModelRoomBuild(input)
  assert.deepEqual(tampered.selected_route, baseline)
  assert.equal(tampered.qualification_evidence.reason, "signature_mismatch")
  const unavailable = await modelRoom.prepareModelRoomBuild({ ...input,
    policy: { ...policy, evaluationBundle: "missing.json" } })
  assert.deepEqual(unavailable.selected_route, baseline)
  assert.equal(unavailable.qualification_evidence.reason, "invalid_or_missing_bundle")
})

test("preparation selects optional depth and always retains exact required pinned text", async t => {
  const { baseDir, policy, optional } = preparationFixture(t)
  policy.optionalContext = [optional]
  fs.writeFileSync(path.join(baseDir, "required.txt"), "uncommitted replacement")
  const result = await modelRoom.prepareModelRoomBuild({ task: common.task, policy, baseDir, apiKey: "test",
    fetchImpl: async (_, request) => {
      const sent = JSON.parse(request.body)
      if (!sent.state.chunks) return jev("baseline")(_, request)
      return { ok: true, async json() { return { model: "jev-1.13.0", answers: {
        context_0: { type: "choice", choice: "short", confidence: 0.8,
          probabilities: { hide: 0.05, short: 0.8, long: 0.1, full: 0.05 } }
      } } } }
    } })
  assert.deepEqual(result.build_context.contracts.map(c => c.excerpt), [excerpt, "a".repeat(600)])
  assert.equal(verifyPinnedBuildContext(result.build_context), true)
  assert.equal(result.context_selection.choices[0].visibility, "short")
  assert.equal(result.context_selection.contracts, undefined)
  const unavailable = await modelRoom.prepareModelRoomBuild({ task: common.task, policy, baseDir })
  assert.deepEqual(unavailable.build_context.contracts.map(c => c.excerpt), [excerpt])
  assert.equal(unavailable.context_selection.reason, "no_api_key")
})
