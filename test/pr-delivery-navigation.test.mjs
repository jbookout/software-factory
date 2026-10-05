import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { keyFor } from "../src/pr-delivery-state.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const repo = "fixture/navigation"
async function fixture() {
  const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "factory-navigation-"))
  const config = path.join(privateRoot, "config.json"), stateDir = path.join(privateRoot, "state")
  await fs.writeFile(config, JSON.stringify({ repos: { [repo]: { checkout: root,
    worktreeRoot: path.join(privateRoot, "worktrees"), requiredChecks: [{ name: "test", appId: 15368 }] } },
    stateDir, codex: { model: "fixture-model", effort: "high" }, privateToken: "CANARY_PRIVATE" }))
  return { config, stateDir, run: (action, ...args) => JSON.parse(execFileSync(process.execPath,
    [path.join(root, "bin/pr-delivery.mjs"), config, action, ...args], { encoding: "utf8" })) }
}

test("navigation: a fresh worker locates the invoked implementation and check policy without creating state", async () => {
  const f = await fixture(), result = f.run("installation-status")
  assert.equal(result.sourceRevision, execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim())
  assert.equal(result.entrypoint, path.join(root, "bin/pr-delivery.mjs"))
  assert.equal(result.policySource, path.join(root, "docs/pr-delivery-cutover.md"))
  assert.deepEqual(result.checkPolicy[repo], [{ name: "test", appId: 15368 }])
  assert.equal(result.installation.status, "unverified")
  assert.equal(result.paths.deliveryLog, path.join(f.stateDir, "delivery.jsonl"))
  await assert.rejects(fs.access(f.stateDir), { code: "ENOENT" })
  assert.doesNotMatch(JSON.stringify(result), /CANARY_PRIVATE/)
})

test("navigation: an existing installation receipt is identified without copying its private contents or asserting installation", async () => {
  const f = await fixture(), config = JSON.parse(await fs.readFile(f.config, "utf8"))
  const receipt = path.join(path.dirname(f.config), "installed.json")
  const bytes = JSON.stringify({ sourceRevision: "b".repeat(40), entrypoint: "/private/installed/review-pr.sh", privateToken: "CANARY_PRIVATE" })
  await fs.writeFile(receipt, bytes)
  await fs.writeFile(f.config, JSON.stringify({ ...config, installationReceipt: "installed.json" }))
  const result = f.run("installation-status")
  assert.equal(result.installation.receipt, receipt)
  assert.equal(result.installation.receiptDigest, createHash("sha256").update(bytes).digest("hex"))
  assert.equal(result.installation.status, "unverified")
  assert.doesNotMatch(JSON.stringify(result), /CANARY_PRIVATE/)
  await assert.rejects(fs.access(f.stateDir), { code: "ENOENT" })
})

test("navigation: malformed private job evidence fails without exposing its contents or writing a status record", async () => {
  const f = await fixture()
  await fs.mkdir(f.stateDir)
  const log = path.join(f.stateDir, "delivery.jsonl"), bytes = "CANARY_PRIVATE malformed JSON\n"
  await fs.writeFile(log, bytes)
  const result = spawnSync(process.execPath, [path.join(root, "bin/pr-delivery.mjs"), f.config, "job-status", repo, "7"], { encoding: "utf8" })
  assert.equal(result.status, 9)
  assert.match(result.stderr, /Delivery navigation unavailable/)
  assert.doesNotMatch(result.stdout + result.stderr, /CANARY_PRIVATE/)
  assert.equal(await fs.readFile(log, "utf8"), bytes)
  assert.deepEqual(await fs.readdir(f.stateDir), ["delivery.jsonl"])
})

test("navigation: job status reads existing waits, queue and review paths without treating a recorded start as running", async () => {
  const f = await fixture(), key = keyFor(repo, 7), head = "a".repeat(40)
  await fs.mkdir(path.join(f.stateDir, "waits"), { recursive: true })
  await fs.mkdir(path.join(f.stateDir, "reviews"))
  const waitFile = path.join(f.stateDir, "waits", `${key}.json`)
  await fs.writeFile(waitFile, JSON.stringify({ schema: "factory-delivery-wait/v1", repo, pr: 7,
    head, status: "suspended", cause: "mutation-uncertain", code: 130, message: "CANARY_PRIVATE" }))
  const reviewFile = path.join(f.stateDir, "reviews", "attempt.json")
  await fs.writeFile(reviewFile, JSON.stringify({ schema: "factory-review/v1", repo, pr: 7, head,
    verdict: "APPROVE", output: path.join(f.stateDir, "output.txt"), argv: ["CANARY_PRIVATE"] }))
  await fs.writeFile(path.join(f.stateDir, "queue.json"), JSON.stringify([{ repo, pr: 7, head, id: "q", attempts: 0, note: "CANARY_PRIVATE" }]))
  const log = path.join(f.stateDir, "delivery.jsonl")
  await fs.writeFile(log, JSON.stringify({ repo, pr: 7, step: "fix", status: "started", at: "2026-10-05T01:31:20.749Z" }) + "\n")
  const before = await fs.readFile(log, "utf8"), result = f.run("job-status", repo, "7")
  assert.equal(result.status, "suspended")
  assert.equal(result.wait.cause, "mutation-uncertain")
  assert.equal(result.lastEvent.status, "started")
  assert.equal(result.lastEvent.evidence, "recorded, not process liveness")
  assert.equal(result.paths.waitReceipt, waitFile)
  assert.equal(result.reviews[0].receipt, reviewFile)
  assert.equal(result.reviews[0].output, path.join(f.stateDir, "output.txt"))
  assert.equal(result.queue[0].status, "queued")
  assert.doesNotMatch(JSON.stringify(result), /CANARY_PRIVATE/)
  assert.equal(await fs.readFile(log, "utf8"), before)
})
