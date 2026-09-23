import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { createPinnedBuildContext, readPinnedContract, routeDoctorCreBuild,
  selectOptionalBuildContext, verifyPinnedBuildContext, signEvaluationBundle,
  authenticateEvaluationBundle } from "../src/model-room.mjs"
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

test("independent failing and unverified cases do not qualify a route", async () => {
  const observations = [observation("pr44", { oracle_status: "fail" }), observation("pr45"),
    observation("pr45"), observation("pr46", { attested: false })]
  const result = await routeDoctorCreBuild({ ...common, observations, apiKey: "test", fetchImpl: jev() })
  assert.deepEqual(result.selected_route, baseline)
  assert.equal(result.qualifications[0].checked_cases, 0)
})

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

test("signed evaluation evidence enables qualified-only production control", async () => {
  const key = "evaluator-secret-key-material-32-bytes-minimum"
  const observations = [observation("pr44"), observation("pr45"), observation("pr46")]
  const bundle = signEvaluationBundle({ control: { task_class: "doctorcre-build",
    mode: "qualified_only", minimum_cases: 3 }, observations }, key)
  const authenticated = authenticateEvaluationBundle(JSON.parse(JSON.stringify(bundle)), key)
  const result = await routeDoctorCreBuild({ ...common,
    observations: authenticated.observations,
    minimumCases: authenticated.minimumCases,
    verifyObservation: authenticated.verifyObservation,
    verifyControl: authenticated.verifyControl,
    controlEnabled: true, apiKey: "test", fetchImpl: jev() })
  assert.deepEqual(result.selected_route, candidate)
  assert.equal(result.selection_reason, "qualified_jev_choice")
  assert.match(authenticated.bundleDigest, /^sha256:[0-9a-f]{64}$/)
  const tampered = JSON.parse(JSON.stringify(bundle))
  tampered.observations[0].oracle_status = "fail"
  assert.throws(() => authenticateEvaluationBundle(tampered, key), /signature mismatch/)
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

test("Jev selects optional context depth while the required pinned contract stays full", async () => {
  const optional = { ...contract, path: "notes/implementation.md",
    excerpt: "a".repeat(4000), content_digest:
      `sha256:${createHash("sha256").update("a".repeat(4000)).digest("hex")}` }
  const chosen = await selectOptionalBuildContext({ task: common.task, chunks: [optional], apiKey: "test",
    fetchImpl: async (_, request) => {
      const sent = JSON.parse(request.body)
      assert.equal(sent.state.chunks[0].excerpt, optional.excerpt)
      return { ok: true, async json() { return { model: "jev-1.13.0", answers: {
        context_0: { type: "choice", choice: "short", confidence: 0.8,
          probabilities: { hide: 0.05, short: 0.8, long: 0.1, full: 0.05 } }
      } } } }
    } })
  const context = createPinnedBuildContext([contract, ...chosen.contracts])
  assert.equal(chosen.choices[0].visibility, "short")
  assert.equal(chosen.contracts[0].excerpt.length, 600)
  assert.equal(context.contracts[0].excerpt, contract.excerpt)
  assert.equal(verifyPinnedBuildContext(context), true)
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
