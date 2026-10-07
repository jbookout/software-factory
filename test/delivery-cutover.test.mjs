import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { runtimePaths } from '../deploy/orch/factory-verify.mjs'

const script = fileURLToPath(new URL("../scripts/orch/delivery-cutover.sh", import.meta.url))
const legacy = ["review-pr.sh", "pr-loop.sh", "merge-queue.sh", "auto-enqueue.sh", "wait-green-enqueue.sh", "shepherd.sh", "gate-merge.sh", "unstick.sh", "merge-queue-keepalive.sh"]
let factory
test.before(async () => {
  factory = await fs.mkdtemp(path.join(os.tmpdir(), 'cutover-source-'))
  for (const name of runtimePaths) {
    await fs.mkdir(path.dirname(path.join(factory,name)), {recursive:true})
    await fs.cp(fileURLToPath(new URL(`../${name}`,import.meta.url)), path.join(factory,name), {recursive:true})
  }
  await fs.symlink(fileURLToPath(new URL('../node_modules',import.meta.url)), path.join(factory,'node_modules'))
  const git = (...args) => execFileSync('git', args, {cwd:factory,stdio:'ignore'})
  git('init'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid')
  git('add',...runtimePaths); git('commit','-qm','Cutover source fixture')
})
test.after(() => fs.rm(factory,{recursive:true,force:true}))

async function orch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-cutover-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const old = path.join(root, 'carr-system/out/orch'), state = path.join(root, 'carr-delivery/state')
  await fs.mkdir(old,{recursive:true}); await fs.mkdir(state,{recursive:true})
  for (const name of legacy) await fs.writeFile(path.join(old, name), `#!/bin/zsh\n# legacy ${name}\n`, { mode: 0o755 })
  await fs.writeFile(path.join(old, "merge-holds.txt"), "# <owner/repo> <title-regex> <reason>\n")
  await fs.writeFile(path.join(old, "merge-queue.txt"), "")
  await fs.writeFile(path.join(old, "merge-queue.done"), "")
  await fs.mkdir(path.join(old,"budget"))
  const config = path.join(root, 'carr-delivery/delivery-config.json')
  await fs.writeFile(config, JSON.stringify({ stateDir: 'state', orchestratorDir:old, statusFile:path.join(old,'delivery-status.txt'),
    repos: {'jbookout/carr-system':{checkout:root,worktreeRoot:path.join(root,'worktrees'),requiredChecks:[{name:'test'}],trustedReviewers:['reviewer']}} }))
  const tools = path.join(root,'tools'); await fs.mkdir(tools)
  const gh = path.join(tools,'gh')
  await fs.writeFile(gh, '#!/bin/sh\nprintf "HTTP/2.0 200 OK\\n\\n[]\\n"\n',{mode:0o755})
  const run = (...args) => spawnSync("sh", [script, ...args], { encoding: "utf8",
    env: { ...process.env, HOME:root, OLD: old, FACTORY:factory, CONFIG: config, PATH:tools+path.delimiter+process.env.PATH,
      CUTOVER_SIMULATE: "1", REPOS: "jbookout/carr-system" } })
  return { root, old, state, config, gh, run }
}

test('live config inside OLD is rejected before moving scripts even in rehearsal', async t => {
  const f = await orch(t)
  const bytes = await fs.readFile(f.config)
  const misplaced = path.join(f.old,'switchover2/delivery-config.json')
  await fs.mkdir(path.dirname(misplaced)); await fs.writeFile(misplaced,bytes)
  const result = spawnSync('sh',[script,'flip'],{encoding:'utf8',env:{...process.env,OLD:f.old,FACTORY:factory,CONFIG:misplaced,CUTOVER_SIMULATE:'1'}})
  assert.notEqual(result.status,0)
  assert.match(result.stderr,/separate/)
  assert.equal(f.run('status').stdout.trim(),'mode: legacy')
  for (const name of legacy) assert.match(await fs.readFile(path.join(f.old,name),'utf8'), /# legacy/)
  await assert.rejects(fs.access(path.join(f.old,'delivery-cutover.json')),{code:'ENOENT'})
})

test('flip defaults to the config outside OLD in ~/carr-delivery', async t => {
  const f = await orch(t)
  const result = spawnSync('sh',[script,'flip'],{encoding:'utf8',env:{...process.env,HOME:f.root,OLD:f.old,FACTORY:factory,
    CONFIG:'',CUTOVER_SIMULATE:'1',PATH:path.dirname(f.gh)+path.delimiter+process.env.PATH}})
  assert.equal(result.status,0,result.stderr)
  assert.equal(f.run('status').stdout.trim(),'mode: factory')
  assert.equal(f.run('rollback').status,0)
})

test('a post-install GitHub error automatically restores legacy and exits nonzero', async t => {
  const f = await orch(t)
  const before = await fs.readFile(path.join(f.old,'pr-loop.sh'))
  await fs.writeFile(f.gh,'#!/bin/sh\nprintf "HTTP/2.0 200 OK\\n\\n{}\\n"\n',{mode:0o755})
  const result = f.run('flip')
  assert.notEqual(result.status,0)
  assert.match(result.stderr,/smoke.*jbookout\/carr-system/)
  assert.equal(f.run('status').stdout.trim(),'mode: legacy')
  assert.deepEqual(await fs.readFile(path.join(f.old,'pr-loop.sh')),before)
  const record = JSON.parse(await fs.readFile(path.join(f.old,'delivery-cutover.json')))
  assert.equal(record.phase,'rolled-back')
  assert.match(record.smokeFailure,/jbookout\/carr-system/)
  assert.doesNotMatch(await fs.readFile(path.join(f.old,'cutover-simulated.log'),'utf8'),/deliver .*--detach/)
})

test('state inside OLD is rejected before preparing a rehearsal journal', async t => {
  const f = await orch(t)
  const config = JSON.parse(await fs.readFile(f.config))
  config.stateDir = path.join(f.old,'switchover2/state')
  await fs.writeFile(f.config,JSON.stringify(config))
  const result = f.run('flip')
  assert.notEqual(result.status,0)
  assert.match(result.stderr,/separate/)
  await assert.rejects(fs.access(path.join(f.old,'delivery-cutover.json')),{code:'ENOENT'})
})

test('smoke covers all configured repos and rolls back when a later repo fails', async t => {
  const f = await orch(t)
  const config = JSON.parse(await fs.readFile(f.config))
  config.repos['jbookout/doctorcre-app'] = config.repos['jbookout/carr-system']
  await fs.writeFile(f.config,JSON.stringify(config))
  await fs.writeFile(f.gh,'#!/bin/sh\ncase "$*" in *doctorcre-app*) printf "HTTP/2.0 401 Unauthorized\\n\\n{}\\n"; exit 1;; *) printf "HTTP/2.0 200 OK\\n\\n[]\\n";; esac\n',{mode:0o755})
  const result = f.run('flip')
  assert.notEqual(result.status,0)
  assert.match(result.stdout,/smoke jbookout\/carr-system/)
  assert.match(result.stderr,/doctorcre-app.*authentication refused/)
  const record = JSON.parse(await fs.readFile(path.join(f.old,'delivery-cutover.json')))
  assert.equal(record.phase,'rolled-back')
  assert.equal(record.smoke['jbookout/carr-system'].pulls,0)
  assert.equal(f.run('status').stdout.trim(),'mode: legacy')
})

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

test('PR63 repair: omitted stateDir survives isolated installed cutover and verification',async t=>{
 const f=await orch(t),config=JSON.parse(await fs.readFile(f.config));delete config.stateDir
 await fs.writeFile(f.config,JSON.stringify(config))
 const flip=f.run('flip');assert.equal(flip.status,0,flip.stderr)
 const receipt=JSON.parse(await fs.readFile(path.join(f.old,'.factory-orch.json')))
 assert.equal(receipt.stateDir,path.join(await fs.realpath(f.root),'carr-delivery/state'))
 const verify=spawnSync('sh',[path.join(f.old,'review-pr.sh'),'--factory-binding'],{encoding:'utf8',env:{...process.env,HOME:f.root}})
 assert.equal(verify.status,0,verify.stderr)
 assert.equal(JSON.parse(verify.stdout).stateDir,receipt.stateDir)
 assert.equal(f.run('rollback').status,0)
})

test('PR63 repair: missing base.ref cannot activate the installed simulated cutover',async t=>{
 const f=await orch(t)
 const row={id:7,number:7,title:'Fixture',draft:false,head:{sha:'a'.repeat(40)},base:{sha:'b'.repeat(40),repo:{full_name:'jbookout/carr-system'}}}
 await fs.writeFile(f.gh,'#!/bin/sh\nprintf \'HTTP/2.0 200 OK\\n\\n'+JSON.stringify([row])+'\\n\'\n',{mode:0o755})
 const flip=f.run('flip');assert.notEqual(flip.status,0)
 assert.match(flip.stderr,/invalid GitHub (?:observation shape|pull-list response)/)
 assert.equal(f.run('status').stdout.trim(),'mode: legacy')
 const record=JSON.parse(await fs.readFile(path.join(f.old,'delivery-cutover.json')))
 assert.equal(record.phase,'rolled-back')
 assert.doesNotMatch(await fs.readFile(path.join(f.old,'cutover-simulated.log'),'utf8'),/deliver .*--detach/)
})
