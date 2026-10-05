import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { compareShadow } from "../src/delivery-shadow.mjs"

const script = fileURLToPath(new URL("../scripts/orch/delivery-cutover.sh", import.meta.url))
const legacy = ["review-pr.sh", "pr-loop.sh", "merge-queue.sh", "auto-enqueue.sh", "wait-green-enqueue.sh", "gate-merge.sh", "unstick.sh", "merge-queue-keepalive.sh"]

async function orch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-cutover-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const old = path.join(root, "orch"), state = path.join(root, "state")
  await fs.mkdir(old); await fs.mkdir(state)
  for (const name of legacy) await fs.writeFile(path.join(old, name), `#!/bin/zsh\n# legacy ${name}\n`, { mode: 0o755 })
  await fs.writeFile(path.join(old, "merge-holds.txt"), "# <owner/repo> <title-regex> <reason>\n")
  await fs.writeFile(path.join(old, "merge-queue.txt"), "")
  const config = path.join(root, "config.json")
  await fs.writeFile(config, JSON.stringify({ stateDir: "state" }))
  const run = (...args) => spawnSync("sh", [script, ...args], { encoding: "utf8",
    env: { ...process.env, OLD: old, CONFIG: config, CUTOVER_SIMULATE: "1", REPOS: "jbookout/carr-system" } })
  return { root, old, state, run }
}

test("shadow -> flip -> rollback moves files only and restores the legacy scripts byte for byte", async t => {
  const { old, state, run } = await orch(t)
  const before = Object.fromEntries(await Promise.all(legacy.map(async n => [n, await fs.readFile(path.join(old, n), "utf8")])))
  assert.equal(run("status").stdout.trim(), "mode: legacy")
  assert.equal(run("flip").status, 1, "flip requires a shadow phase first")

  assert.equal(run("shadow").status, 0)
  assert.match(await fs.readFile(path.join(old, "cutover-simulated.log"), "utf8"), /pr-delivery\.mjs' '.*' shadow 'jbookout\/carr-system'/)
  for (const name of legacy) await fs.access(path.join(old, name)) // shadow touches no legacy file

  const flip = run("flip"); assert.equal(flip.status, 0, flip.stderr)
  assert.equal(run("status").stdout.trim(), "mode: factory")
  const [moved] = (await fs.readdir(path.join(old, "_to_delete"))).filter(n => n.startsWith("orch-legacy-"))
  const manifest = await fs.readFile(path.join(old, "_to_delete", moved, "MANIFEST"), "utf8")
  for (const name of legacy) assert.match(manifest, new RegExp(` ${name.replace(".", "\\.")}$`, "m"))
  assert.match(await fs.readFile(path.join(old, "pr-loop.sh"), "utf8"), /factory-entry\.sh" deliver/, "installed wrapper replaces pr-loop.sh")
  await assert.rejects(fs.access(path.join(old, "gate-merge.sh")), { code: "ENOENT" }, "a legacy direct-merge path is moved aside")
  const log = await fs.readFile(path.join(old, "cutover-simulated.log"), "utf8")
  assert.match(log, /import-legacy/); assert.match(log, /deliver\.sh 'jbookout\/carr-system'/); assert.match(log, /pkill -f '\(\^\|\/\| \)merge-queue-keepalive\.sh/)

  await fs.writeFile(path.join(state, "queue.json"), JSON.stringify([
    { repo: "jbookout/carr-system", pr: 9, head: "a".repeat(40), note: "auto", outcome: null },
    { repo: "jbookout/carr-system", pr: 8, head: "b".repeat(40), note: "done", outcome: { status: "pass" } }]))
  const back = run("rollback"); assert.equal(back.status, 0, back.stderr)
  assert.match(back.stdout, /1 pending factory queue entry carried/)
  assert.equal(run("status").stdout.trim(), "mode: legacy")
  for (const name of legacy) assert.equal(await fs.readFile(path.join(old, name), "utf8"), before[name], name)
  assert.equal(await fs.readFile(path.join(old, "merge-queue.txt"), "utf8"), `jbookout/carr-system 9 ${"a".repeat(40)} factory rollback: auto\n`)
  const kept = (await fs.readdir(path.join(old, "_to_delete"))).find(n => n.startsWith("factory-wrappers-"))
  await fs.access(path.join(old, "_to_delete", kept, "deliver.sh"))
  assert.match(await fs.readFile(path.join(old, "cutover-simulated.log"), "utf8"), /nohup zsh merge-queue-keepalive\.sh/)
})

test("rollback refuses to overwrite a file that reappeared in the orchestrator directory", async t => {
  const { old, run } = await orch(t)
  run("shadow"); run("flip")
  await fs.writeFile(path.join(old, "gate-merge.sh"), "new hand edit\n")
  const back = run("rollback")
  assert.notEqual(back.status, 0); assert.match(back.stderr, /gate-merge\.sh exists; refusing to overwrite/)
  assert.equal(await fs.readFile(path.join(old, "gate-merge.sh"), "utf8"), "new hand edit\n")
})

test("compare reports tier-1 and merge disagreements against the old path", () => {
  const rec = (pr, head, open, legacy) => ({ schema: "factory-delivery-shadow/v1", repo: "r/x", pr, head, state: open ? "OPEN" : "MERGED", ...open, legacy })
  const h = c => c.repeat(40)
  const report = compareShadow([
    rec(1, h("a"), { tier: 1, wouldReview: "none", wouldApprove: true, wouldMerge: true, frozen: false }, { verdict: "APPROVE", reviewedSha: h("a"), merged: false }),
    rec(1, h("a"), null, { verdict: "APPROVE", reviewedSha: h("a"), merged: true }),
    rec(2, h("b"), { tier: 1, wouldReview: "none", wouldApprove: true, wouldMerge: false, frozen: true }, { verdict: "REVIEW: BLOCKED", reviewedSha: h("b"), merged: false }),
    rec(2, h("b"), null, { verdict: "REVIEW: BLOCKED", reviewedSha: h("b"), merged: true }),
    rec(3, h("c"), { tier: 3, wouldReview: "full", wouldApprove: null, wouldMerge: false, frozen: false }, { verdict: null, reviewedSha: null, merged: false }),
    rec(4, h("d"), { tier: 2, wouldReview: "focused", wouldApprove: null, wouldMerge: false, frozen: false }, { verdict: "APPROVE", reviewedSha: h("e"), merged: false }),
  ])
  assert.deepEqual(report.tiers, { 1: 2, 2: 1, 3: 1 })
  assert.equal(report.modelReviewsAvoided, 2); assert.equal(report.focusedInsteadOfFull, 1)
  assert.deepEqual(report.tier1Approval, { compared: 2, agreePercent: 50, disagreements: [`r/x#2@${"b".repeat(12)} shadow APPROVE / old REVIEW: BLOCKED`] })
  assert.equal(report.merge.compared, 2); assert.equal(report.merge.agreePercent, 50)
  assert.deepEqual(report.merge.mergedWhileFrozen, [`r/x#2@${"b".repeat(12)}`])
  assert.equal(report.pending, 2)
})
