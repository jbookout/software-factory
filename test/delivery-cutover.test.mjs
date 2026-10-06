import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("../scripts/orch/delivery-cutover.sh", import.meta.url))
const legacy = ["review-pr.sh", "pr-loop.sh", "merge-queue.sh", "auto-enqueue.sh", "wait-green-enqueue.sh", "shepherd.sh", "gate-merge.sh", "unstick.sh", "merge-queue-keepalive.sh"]

async function orch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-cutover-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const old = path.join(root, "orch"), state = path.join(root, "state")
  await fs.mkdir(old); await fs.mkdir(state)
  for (const name of legacy) await fs.writeFile(path.join(old, name), `#!/bin/zsh\n# legacy ${name}\n`, { mode: 0o755 })
  await fs.writeFile(path.join(old, "merge-holds.txt"), "# <owner/repo> <title-regex> <reason>\n")
  await fs.writeFile(path.join(old, "merge-queue.txt"), "")
  await fs.writeFile(path.join(old, "merge-queue.done"), "")
  await fs.mkdir(path.join(old,"budget"))
  const config = path.join(root, "config.json")
  await fs.writeFile(config, JSON.stringify({ stateDir: "state", repos: {"jbookout/carr-system":{}} }))
  const run = (...args) => spawnSync("sh", [script, ...args], { encoding: "utf8",
    env: { ...process.env, OLD: old, CONFIG: config, CUTOVER_SIMULATE: "1", REPOS: "jbookout/carr-system" } })
  return { root, old, state, run }
}

test("direct flip -> rollback moves files only and restores the legacy scripts byte for byte", async t => {
  const { old, state, run } = await orch(t)
  const before = Object.fromEntries(await Promise.all(legacy.map(async n => [n, await fs.readFile(path.join(old, n), "utf8")])))
  assert.equal(run("status").stdout.trim(), "mode: legacy")
  assert.notEqual(run("shadow").status, 0, "there is no shadow cutover mode")

  const flip = run("flip"); assert.equal(flip.status, 0, flip.stderr)
  assert.equal(run("status").stdout.trim(), "mode: factory")
  const [moved] = (await fs.readdir(path.join(old, "_to_delete"))).filter(n => n.startsWith("orch-legacy-"))
  const manifest = await fs.readFile(path.join(old, "_to_delete", moved, "MANIFEST"), "utf8")
  for (const name of legacy) assert.match(manifest, new RegExp(` ${name.replace(".", "\\.")}$`, "m"))
  assert.match(await fs.readFile(path.join(old, "pr-loop.sh"), "utf8"), /factory-entry\.sh" deliver/, "installed wrapper replaces pr-loop.sh")
  await assert.rejects(fs.access(path.join(old, "gate-merge.sh")), { code: "ENOENT" }, "a legacy direct-merge path is moved aside")
  const log = await fs.readFile(path.join(old, "cutover-simulated.log"), "utf8")
  assert.match(log, /import-legacy/); assert.match(log, /deliver jbookout\/carr-system --detach/); assert.match(log, /stop legacy processes/)

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
  assert.match(await fs.readFile(path.join(old, "cutover-simulated.log"), "utf8"), /restart legacy merge-queue-keepalive\.sh/)
})

test("rollback refuses to overwrite a file that reappeared in the orchestrator directory", async t => {
  const { old, run } = await orch(t)
  run("flip")
  await fs.writeFile(path.join(old, "gate-merge.sh"), "new hand edit\n")
  const back = run("rollback")
  assert.notEqual(back.status, 0); assert.match(back.stderr, /gate-merge\.sh exists; refusing to overwrite/)
  assert.equal(await fs.readFile(path.join(old, "gate-merge.sh"), "utf8"), "new hand edit\n")
})

test("cutover carries queue, budget and in-flight PR state and rollback restores it",async t=>{
 const {old,state,run}=await orch(t)
 await fs.mkdir(path.join(old,"locks"))
 const line=`jbookout/carr-system 1536 ${"a".repeat(40)} approved`
 await fs.writeFile(path.join(old,"merge-queue.txt"),line+"\n")
 await fs.writeFile(path.join(old,"merge-queue.done"),"")
 await fs.writeFile(path.join(old,"loop-carr-system-1536.log"),"BUDGET-STOP\n")
 await fs.writeFile(path.join(old,"locks/pr-loop-carr-system-1536.pid"),"12345\n")
 await fs.writeFile(path.join(old,"budget/carr-system-1536.log"),`${Math.floor(Date.now()/1000)} fix\n`)
 const flip=run("flip");assert.equal(flip.status,0,flip.stderr)
 assert.equal(JSON.parse(await fs.readFile(path.join(state,"queue.json")))[0].pr,1536)
 assert.equal(Object.values(JSON.parse(await fs.readFile(path.join(state,"inflight.json"))))[0].lastStatus,"BUDGET-STOP")
 assert.equal(JSON.parse(await fs.readFile(path.join(state,"usage.json"))).length,1)
 assert.match(await fs.readFile(path.join(old,"cutover-simulated.log"),"utf8"),/stop launchd jobs/)
 assert.equal(run("rollback").status,0)
 assert.equal((await fs.readFile(path.join(old,"merge-queue.txt"),"utf8")).trim(),line)
})

test('interrupted rollback retains restored scripts when installation receipt has moved', async t => {
 const {old,run}=await orch(t)
 const before=await fs.readFile(path.join(old,'pr-loop.sh'),'utf8')
 assert.equal(run('flip').status,0)
 const record=JSON.parse(await fs.readFile(path.join(old,'delivery-cutover.json')))
 const partial=path.join(old,'_to_delete','partial-rollback');await fs.mkdir(partial)
 await fs.rename(path.join(old,'.factory-orch.json'),path.join(partial,'.factory-orch.json'))
 await fs.rename(path.join(old,'pr-loop.sh'),path.join(partial,'pr-loop.sh'))
 await fs.rename(path.join(record.backup,'pr-loop.sh'),path.join(old,'pr-loop.sh'))
 const result=run('rollback');assert.equal(result.status,0,result.stderr)
 assert.equal(await fs.readFile(path.join(old,'pr-loop.sh'),'utf8'),before)
 assert.equal(run('status').stdout.trim(),'mode: legacy')
})
