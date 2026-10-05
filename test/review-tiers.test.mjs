import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { decideReview, reviewDecision, routeTier, isTestFile } from "../src/review-tiers.mjs"

const fixtures = new URL("./fixtures/review-tiers/", import.meta.url)
const carr = JSON.parse(await fs.readFile(new URL("carr-system.v1.json", fixtures), "utf8"))
const factoryMap = name => new URL(`../config/review-tiers/${name}.v1.json`, import.meta.url)
const bind = { base: "a".repeat(40), head: "b".repeat(40), policyRevision: "c".repeat(40), diffDigest: "sha256:" + "d".repeat(64) }
const route = (paths, doc = carr) => routeTier(reviewDecision(paths.map(path => ({ path })), { ...bind, doc }), doc)

const CARR_POLICY_DIGEST = "sha256:aba1ad25ea933c6d843344bcea47f19b7752bb0ef0c938dc9031350962d6c96a"

test("decision matches carr-system's Python review_decision byte for byte", () => {
  const tunable = { path: "ops/config/jev-cost-guard.v1.json", before: { daily_paid_call_cap: 10, x: 1 }, after: { daily_paid_call_cap: 20, x: 1 }, mode_changed: false }
  const decision = reviewDecision([tunable], { ...bind, doc: carr })
  assert.deepEqual(decision, { schema: "repository-review-decision/v1", base: bind.base, head: bind.head,
    policy_revision: bind.policyRevision, diff_digest: bind.diffDigest, policy_digest: CARR_POLICY_DIGEST,
    changed_paths: [tunable.path], code_lines: 0, test_lines: 0, change_size: "small", code_paths: [tunable.path], test_paths: [], lane: "tunable_scalar", tier: 1,
    validated_fields: [{ path: tunable.path, field: "daily_paid_call_cap", before: 10, after: 20 }], required_ci: true })
  assert.equal(reviewDecision([{ path: "ops/release-pipeline.py" }], { ...bind, doc: carr }).tier, 3)
  assert.equal(reviewDecision([{ path: "mcp-server/src/deals.js" }], { ...bind, doc: carr }).tier, 2)
  assert.equal(reviewDecision([{ path: "lib/foo.py" }], { ...bind, doc: carr }).tier, 1)
})

test("a one-line change in a tier-3 path stays tier 3", async () => {
  assert.equal(route(["ops/release-pipeline.py"]).tier, 3)
  assert.equal(route(["mcp-server/src/deals.js", "migrations/0999_one_line.sql"]).tier, 3)
  assert.equal(route(["docs/readme-typo.md", "deploy/orch/factory-entry.sh"], JSON.parse(await fs.readFile(factoryMap("software-factory"), "utf8"))).tier, 3)
})

test("a path no rule classifies routes to tier 3 even under a tier-1 default", () => {
  assert.equal(reviewDecision([{ path: "lib/foo.py" }], { ...bind, doc: carr }).tier, 1, "carr's floor says 1")
  assert.deepEqual(route(["lib/foo.py"]), { tier: 3, reason: "unclassified path: lib/foo.py" })
  assert.equal(route(["mcp-server/src/deals.js"]).tier, 2)
})

test("unknown or unparseable input routes to tier 3", () => {
  assert.equal(routeTier(null, carr).tier, 3)
  assert.equal(routeTier(reviewDecision([], { ...bind, doc: carr }), carr).tier, 3)
  assert.equal(route(["./"]).tier, 3)
  assert.throws(() => reviewDecision([{ path: "a" }], { ...bind, doc: { ...carr, default_tier: true } }), /invalid review policy/)
  assert.equal(routeTier({ ...reviewDecision([{ path: "mcp-server/src/a.js" }], { ...bind, doc: carr }), tier: 7 }, carr).tier, 3)
})

test("factory path maps use the carr schema and classify their repositories", async () => {
  for (const name of ["software-factory", "doctorcre-app"]) {
    const doc = JSON.parse(await fs.readFile(factoryMap(name), "utf8"))
    assert.equal(doc.schema_version, "review-tiers.v1")
    assert.equal(doc.default_tier, 1)
  }
  const sf = JSON.parse(await fs.readFile(factoryMap("software-factory"), "utf8"))
  const app = JSON.parse(await fs.readFile(factoryMap("doctorcre-app"), "utf8"))
  assert.equal(route(["docs/finish-line.md"], sf).tier, 1)
  assert.equal(route(["src/design-manager.mjs"], sf).tier, 2)
  assert.equal(route(["src/pr-delivery.mjs"], sf).tier, 3)
  assert.equal(route(["AGENTS.md"], sf).tier, 3)
  assert.equal(route(["unknown-top-level.txt"], sf).tier, 3)
  assert.equal(route(["test-artifacts/w7/shot.png"], app).tier, 1)
  assert.equal(route(["js/slices/leads.js", "leads.html"], app).tier, 2)
  assert.equal(route(["wrangler.jsonc"], app).tier, 3)
  assert.equal(route(["scripts/privacy/scan.mjs"], app).tier, 3)
})

test("decideReview binds base, head, policy and diff digests from git", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-tiers-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "F", GIT_AUTHOR_EMAIL: "f@example.invalid", GIT_COMMITTER_NAME: "F", GIT_COMMITTER_EMAIL: "f@example.invalid" }
  const g = (...a) => execFileSync("git", a, { cwd: root, env, encoding: "utf8" }).trim()
  const git = async (cwd, ...a) => execFileSync("git", a, { cwd, env, encoding: "utf8" })
  g("init", "-q", "-b", "main")
  await fs.mkdir(path.join(root, "ops/config"), { recursive: true })
  await fs.writeFile(path.join(root, "ops/config/review-tiers.v1.json"), JSON.stringify(carr))
  await fs.writeFile(path.join(root, "ops/config/jev-cost-guard.v1.json"), JSON.stringify({ daily_paid_call_cap: 10 }))
  g("add", "."); g("commit", "-qm", "base"); const base = g("rev-parse", "HEAD")
  await fs.writeFile(path.join(root, "ops/config/jev-cost-guard.v1.json"), JSON.stringify({ daily_paid_call_cap: 20 }))
  g("commit", "-qam", "tunable"); const tunable = g("rev-parse", "HEAD")
  await fs.mkdir(path.join(root, "mcp-server/src"), { recursive: true })
  await fs.writeFile(path.join(root, "mcp-server/src/deals.js"), "export const x = 1\n")
  g("add", "."); g("commit", "-qm", "code"); const code = g("rev-parse", "HEAD")
  const policy = { repositoryPath: "ops/config/review-tiers.v1.json" }

  const first = await decideReview({ git, cwd: root, base, head: tunable, policy })
  assert.equal(first.tier, 1); assert.equal(first.decision.lane, "tunable_scalar")
  assert.equal(first.decision.policy_revision, base); assert.equal(first.decision.policy_digest, CARR_POLICY_DIGEST)
  const diff = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "--no-textconv", base, tunable], { cwd: root, env })
  assert.equal(first.decision.diff_digest, "sha256:" + (await import("node:crypto")).createHash("sha256").update(diff).digest("hex"))
  assert.match(first.digest, /^sha256:[0-9a-f]{64}$/)

  const second = await decideReview({ git, cwd: root, base, head: code, policy })
  assert.equal(second.tier, 3, "the mixed change keeps its highest tier")
  assert.notEqual(second.digest, first.digest)

  assert.deepEqual(await decideReview({ git, cwd: root, base, head: code, policy: undefined }).then(r => [r.tier, r.reason]), [3, "no review policy configured"])
  assert.equal((await decideReview({ git, cwd: root, base, head: code, policy: { repositoryPath: "missing.json" } })).tier, 3)
  await fs.writeFile(path.join(root, "bad.json"), "{not json")
  assert.equal((await decideReview({ git, cwd: root, base, head: code, policy: { file: path.join(root, "bad.json") } })).tier, 3)
})

test("code-only size, test review floor and ops tier are preserved", () => {
  const decision = reviewDecision([{path:"lib/example.py",additions:2,deletions:1},
    {path:"tests/test_example.py",additions:400,deletions:0}], {...bind,doc:carr})
  assert.deepEqual([decision.code_lines,decision.test_lines,decision.change_size],[3,400,"small"])
  assert.deepEqual(decision.test_paths,["tests/test_example.py"])
  const tests = reviewDecision([{path:"tests/test_example.py",additions:400}],{...bind,doc:carr})
  assert.equal(tests.tier,2)
  assert.equal(reviewDecision([{path:"ops/example-selftest.py",additions:400}],{...bind,doc:carr}).tier,3)
})

test("review diff orders code before test evidence without dropping a file", async () => {
  const {assembleReviewDiff} = await import("../src/review-tiers.mjs")
  const decision=reviewDecision([{path:"a.test.ts",additions:400},{path:"z.ts",additions:3}],{...bind,doc:carr})
  const git=async(cwd,...args)=>args.slice(args.indexOf("--")+1).map(p=>`diff --git a/${p} b/${p}\n+changed\n`).join("")
  const diff=await assembleReviewDiff({git,cwd:"fixture",base:bind.base,head:bind.head,decision})
  assert.equal(diff,"Code changes\ndiff --git a/z.ts b/z.ts\n+changed\n\nTests (evidence)\ndiff --git a/a.test.ts b/a.test.ts\n+changed\n")
})

test("factory decisions match generated Python decisions and the policy digest pin", async () => {
  const vectors=JSON.parse(await fs.readFile(new URL("tier-vectors.v1.json",fixtures),"utf8"))
  assert.equal(vectors.policy_digest,CARR_POLICY_DIGEST)
  for(const row of vectors.change_vectors)
    assert.deepEqual(reviewDecision(row.changes,{...bind,doc:carr}),row.decision)
  for(const row of vectors.vectors) assert.equal(isTestFile(row.path,carr),row.test,row.path)
})
