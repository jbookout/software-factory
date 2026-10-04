import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { runProcess } from "../src/process-runner.mjs"
import { runCodexBuild } from "../src/codex-build.mjs"
import { createPinnedBuildContext } from "../src/model-room.mjs"

test("buffered streams preserve UTF-8 split across byte chunks", async () => {
  const result = await runProcess([process.execPath, "-e", `
    for (const s of [process.stdout, process.stderr]) s.write(Buffer.from([0xe2]));
    setTimeout(() => { for (const s of [process.stdout, process.stderr]) s.write(Buffer.from([0x82,0xac])); }, 50);
  `])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, "€")
  assert.equal(result.stderr, "€")
})

test("process seam treats arguments literally without a shell", async () => {
  const literal = "$(not-a-command); `not-a-command`"
  const result = await runProcess([process.execPath, "-e", "process.stdout.write(process.argv[1])", literal])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, literal)
})

test("streamed Codex output does not impose an accidental output budget", async () => {
  let bytes = 0
  const result = await runProcess([process.execPath, "-e", "process.stdout.write('x'.repeat(2000000))"], {
    captureOutput: false, onOutput: chunk => { bytes += chunk.length }
  })
  assert.equal(result.code, 0)
  assert.equal(bytes, 2_000_000)
  assert.equal(result.stdout, "")
})

test("hard timeout kills grandchildren that hold inherited pipes open", async () => {
  const code = "require('child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
  const start = Date.now()
  const result = await runProcess([process.execPath, "-e", code], { timeoutMs: 300 })
  assert.equal(result.code, 142)
  assert.ok(Date.now() - start < 3000)
})

test("existing attended build caller still reads its schema result", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-build-process-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const codex = path.join(root, "codex")
  await fs.writeFile(codex, `#!/usr/bin/env node
const fs=require('node:fs'), args=process.argv.slice(2);
process.stdin.resume();process.stdin.on('end',()=>{
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({status:'pass'}));
});`, { mode: 0o755 })
  const excerpt = "Fixture contract"
  const pinnedBuildContext = createPinnedBuildContext([{ source_revision: "a".repeat(40),
    path: "src/fixture.mjs", excerpt,
    content_digest: `sha256:${createHash("sha256").update(excerpt).digest("hex")}` }])
  const result = await runCodexBuild({ route: { provider: "codex", model: "fixture", effort: "high" },
    outcome: "Fixture build", sourceRevision: "a".repeat(40), pinnedBuildContext }, { cwd: root, codex })
  assert.equal(result.status, "pass")
})

test('cancellation kills child/grandchild and returns uncertain for a mutation', async () => {
  const { treeScript, waitGone } = await import('./helpers/deadline-and-process.mjs')
  const controller = new AbortController()
  let output = ''
  const result = await runProcess([process.execPath, '-e', treeScript], {
    timeoutMs: 1000, signal: controller.signal, mutation: true,
    onOutput(chunk) { output += chunk; if (output.includes('DESCENDANT:')) controller.abort() }
  })
  assert.equal(result.cancelled, true)
  assert.equal(result.uncertain, true)
  assert.equal(result.nextAction, 'readback-before-retry')
  assert.ok(await waitGone(Number(/DESCENDANT:(\d+)/.exec(output)[1])))
})

test('supervisor binding that never settles stays inside total process budget', async () => {
  const start = Date.now()
  const result = await runProcess([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
    timeoutMs: 250, onSpawn: () => new Promise(() => {})
  })
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - start < 1500)
})

test('binding exception cleans supervisor without leaking raw error text', async () => {
  const { waitGone } = await import('./helpers/deadline-and-process.mjs')
  let pid
  await assert.rejects(runProcess([process.execPath, '-e', ''], {
    timeoutMs: 500, onSpawn(job) { pid = job.pid; throw Error('CANARY_PRIVATE_LAUNCH_ERROR') }
  }), /process launch binding failed/)
  assert.ok(await waitGone(pid))
})

test('missing executable fails without orphaning a supervisor',async()=>{
 const {waitGone}=await import('./helpers/deadline-and-process.mjs')
 const result=await runProcess(['/fixture/no-such-executable'],{timeoutMs:1000})
 assert.notEqual(result.code,0);assert.equal(result.started,false);assert.ok(await waitGone(result.pid))
})

test('supervisor death stops its owned group and retains mutation uncertainty',async()=>{
 const {treeScript,waitGone}=await import('./helpers/deadline-and-process.mjs')
 let supervisor,output='',stopped=false
 const result=await runProcess([process.execPath,'-e',treeScript],{timeoutMs:1500,mutation:true,
  onSpawn(job){supervisor=job.pid;return []},
  onOutput(chunk){output+=chunk;if(output.includes('DESCENDANT:')&&!stopped){stopped=true;process.kill(supervisor,'SIGKILL')}}
 })
 assert.equal(result.uncertain,true);assert.notEqual(result.code,0)
 assert.ok(await waitGone(supervisor));assert.ok(await waitGone(Number(/DESCENDANT:(\d+)/.exec(output)[1])))
})

test('a stalled lease binding cannot run the command before the launch latch opens',async t=>{
 if(process.platform==='win32') return t.skip('POSIX FIFO lease fixture')
 const {execFileSync}=await import('node:child_process')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-launch-latch-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const fifo=path.join(root,'binding'),effect=path.join(root,'effect')
 execFileSync('mkfifo',[fifo])
 const start=Date.now()
 const result=await runProcess([process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(effect)},'ran')`],{
  timeoutMs:500,onSpawn:()=>[{file:fifo,token:'fixture-token'}]
 })
 assert.equal(result.timedOut,true);assert.ok(Date.now()-start<1000)
 await assert.rejects(fs.access(effect),{code:'ENOENT'})
})

test('a permission error on a live group remains a refusal',async t=>{
 const {execFileSync}=await import('node:child_process')
 const {killOwnedGroup,ownedGroupAlive}=await import('../src/process-group.mjs')
 const group=Number(execFileSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim())
 t.mock.method(process,'kill',()=>{const error=Error('synthetic permission refusal');error.code='EPERM';throw error})
 assert.equal(ownedGroupAlive(group),true)
 assert.throws(()=>killOwnedGroup(group,'SIGKILL'),{code:'EPERM'})
})
