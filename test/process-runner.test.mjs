import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { runProcess } from "../src/process-runner.mjs"
import { runCodexBuild } from "../src/codex-build.mjs"
import { createPinnedBuildContext } from "../src/model-room.mjs"

test('review 1: latched and direct command signals retain mutation uncertainty', async t => {
  const { acquireLease } = await import('../src/pr-delivery-state.mjs')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-signal-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const latched of [false, true]) {
    const release = await acquireLease(root, 'signal')
    try {
      const result = await runProcess([process.execPath, '-e', "process.kill(process.pid,'SIGKILL')"], {
        timeoutMs: 2000, mutation: true, onSpawn: latched ? job => release.bindJob(job).then(binding => [binding]) : undefined
      })
      assert.equal(result.signal, 'SIGKILL')
      assert.notEqual(result.code, 0)
      assert.equal(result.uncertain, true)
    } finally { await release() }
  }
})

test('review 2: timeout revokes a pending launch binding before lease release', async t => {
  const { acquireLease } = await import('../src/pr-delivery-state.mjs')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-late-bind-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const release = await acquireLease(root, 'late')
  let resume, settled, bindingSignal
  const latch = new Promise(resolve => { resume = resolve })
  const done = new Promise(resolve => { settled = resolve })
  const result = await runProcess(['/usr/bin/true'], { timeoutMs: 100,
    onSpawn: async (job, signal) => {
      bindingSignal = signal
      await latch
      try { return [await release.bindJob(job)] } catch { return [] } finally { settled() }
    }
  })
  await release()
  resume(); await done
  assert.equal(result.code, 142)
  assert.deepEqual(await fs.readdir(path.join(root, 'late.claims')), [])
  assert.equal(bindingSignal?.aborted, true)
})

test('review 9: process timers reject overflow before binding or launch', async () => {
  let bound = false
  await assert.rejects(runProcess(['/usr/bin/true'], { timeoutMs: 3000000000,
    onSpawn: () => { bound = true }
  }), /invalid process request/)
  assert.equal(bound, false)
})

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

test('wall-clock corrections cannot shorten the active process budget',async t=>{
 t.mock.method(Date,'now',()=>0)
 const result=await runProcess([process.execPath,'-e',"process.stdout.write('healthy')"],{timeoutMs:2000})
 assert.equal(result.code,0);assert.equal(result.stdout,'healthy')
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

test('macOS retired-group readback uses the system observer rather than a PATH shim',async t=>{
 if(process.platform!=='darwin') return t.skip('macOS retired-group EPERM behavior')
 const {execFileSync}=await import('node:child_process')
 const groups=new Set(execFileSync('/bin/ps',['-axo','pgid='],{encoding:'utf8'}).trim().split(/\s+/).map(Number))
 let group=32766
 while(groups.has(group)) group--
 const {killOwnedGroup,ownedGroupAlive}=await import('../src/process-group.mjs')
 const {spawn}=await import('node:child_process')
 const retired=spawn(process.execPath,['-e',''],{detached:true,stdio:'ignore'})
 await new Promise((resolve,reject)=>{retired.on('close',resolve);retired.on('error',reject)})
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-group-observer-')),prior=process.env.PATH
 t.after(async()=>{process.env.PATH=prior;await fs.rm(root,{recursive:true,force:true})})
 await fs.writeFile(path.join(root,'ps'),`#!/bin/sh\necho "${group} ${group} R"\n`,{mode:0o755})
 process.env.PATH=root+path.delimiter+prior
 t.mock.method(process,'kill',()=>{const error=Error('synthetic retired-group EPERM');error.code='EPERM';throw error})
 assert.equal(ownedGroupAlive(group),false)
 assert.doesNotThrow(()=>killOwnedGroup(group,'SIGKILL'))
})

test('macOS retired-group cleanup does not require a global process-table scan',async t=>{
 if(process.platform!=='darwin') return t.skip('macOS retired-group EPERM behavior')
 const cp=await import('node:child_process'),{syncBuiltinESMExports}=await import('node:module')
 const {killOwnedGroup,ownedGroupAlive}=await import('../src/process-group.mjs')
 let readback={status:0,stdout:'31234 31234 Z\n',stderr:''}
 const observer=t.mock.method(cp.default,'spawnSync',(file,args)=>{
  assert.equal(file,'/bin/ps')
  if(args.includes('-axo')) return {error:Object.assign(Error('global scan stalled'),{code:'ETIMEDOUT'}),status:null}
  assert.deepEqual(args,['-g','31234','-o','pid=,pgid=,stat='])
  return readback
 })
 syncBuiltinESMExports()
 t.mock.method(process,'kill',()=>{throw Object.assign(Error('retired group'),{code:'EPERM'})})
 try {
  assert.equal(ownedGroupAlive(31234),false)
  assert.doesNotThrow(()=>killOwnedGroup(31234,'SIGKILL'))
  readback={status:1,stdout:'',stderr:''}
  assert.equal(ownedGroupAlive(31234),false)
  assert.doesNotThrow(()=>killOwnedGroup(31234,'SIGKILL'))
  for(const result of [
   {error:Error('observer stalled'),status:null},
   {status:1,stdout:'',stderr:'observer failed'},
   {status:0,stdout:'unreadable',stderr:''},
   {status:0,stdout:'31235 31235 Z\n',stderr:''},
   {status:0,stdout:'31235 31234 R\n',stderr:''}
  ]) {
   readback=result
   assert.equal(ownedGroupAlive(31234),true)
   assert.throws(()=>killOwnedGroup(31234,'SIGKILL'),{code:'EPERM'})
  }
 } finally {observer.mock.restore();syncBuiltinESMExports()}
})

test('retro 4: running requires this job startup log and acknowledgment', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-startup-'))
 t.after(() => fs.rm(root, {recursive:true, force:true}))
 const job = {id:'startup-fixture', ownership:'caller', worktree:root, model:'fixture', effort:'high',
   log:path.join(root,'job.log'), receipt:path.join(root,'job.json')}
 const release=path.join(root,'acknowledged')
 let acknowledged
 const result = await runProcess([process.execPath,'-e',`console.log("started");const timer=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(release)})){clearInterval(timer)}},10)`], {
   cwd:root, job, onStarted: async receipt => {
     acknowledged = JSON.parse(await fs.readFile(job.receipt, 'utf8'))
     assert.equal(receipt.id, job.id)
     await fs.access(receipt.log)
     await fs.writeFile(release,receipt.id)
   }
 })
 assert.equal(acknowledged?.status,'running')
 assert.equal(acknowledged?.ownership,'caller')
 assert.ok(acknowledged?.groupPid)
 assert.equal(result.code,0)
 const terminal=JSON.parse(await fs.readFile(job.receipt,'utf8'))
 assert.equal(terminal.status,'complete'); assert.equal(terminal.id,job.id)
 assert.equal(await fs.readFile(job.log,'utf8'),'started\n')
})

test('retro 4: unrelated process cannot acknowledge a missing executable',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-missing-start-'))
 t.after(()=>fs.rm(root,{recursive:true,force:true}))
 let running=false
 const job={id:'missing',ownership:'caller',worktree:root,model:'fixture',effort:'high',log:path.join(root,'log'),receipt:path.join(root,'receipt')}
 const result=await runProcess(['/fixture/missing'],{cwd:root,job,onStarted(){running=true}})
 assert.equal(running,false);assert.equal(result.started,false)
 assert.equal(JSON.parse(await fs.readFile(job.receipt,'utf8')).status,'failed')
})

test('retro 4: two caller-owned jobs stop with interruption receipts when their shell ends',async t=>{
 if(process.platform==='win32')return t.skip('POSIX ownership contract')
 const {spawn}=await import('node:child_process')
 const {waitGone}=await import('./helpers/deadline-and-process.mjs')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-owner-'))
 t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const runner=new URL('../src/process-runner.mjs',import.meta.url).href
 const code=`import {runProcess} from ${JSON.stringify(runner)};
 await Promise.all(['one','two'].map(id=>runProcess([process.execPath,'-e','setInterval(()=>{},1000)'],{cwd:${JSON.stringify(root)},timeoutMs:5000,
 job:{id,ownership:'caller',worktree:${JSON.stringify(root)},model:'fixture',effort:'high',log:${JSON.stringify(root)}+'/'+id+'.log',receipt:${JSON.stringify(root)}+'/'+id+'.json'}})))`
 const owner=spawn('sh',['-c','exec "$1" --input-type=module -e "$2"','fixture',process.execPath,code],{stdio:['ignore','pipe','pipe']})
 t.after(()=>{try{owner.kill('SIGKILL')}catch{}})
 const read=id=>fs.readFile(path.join(root,id+'.json'),'utf8').then(JSON.parse).catch(()=>null)
 const until=Date.now()+3000
 while(Date.now()<until && !((await read('one'))?.status==='running'&&(await read('two'))?.status==='running'))await new Promise(r=>setTimeout(r,10))
 assert.equal((await read('one'))?.status,'running');assert.equal((await read('two'))?.status,'running')
 owner.kill('SIGKILL')
 for(const id of ['one','two']){
   const until=Date.now()+3000
   while(Date.now()<until&&(await read(id))?.status==='running')await new Promise(r=>setTimeout(r,10))
   const terminal=await read(id);assert.equal(terminal.status,'interrupted');assert.equal(terminal.code,130)
   assert.ok(await waitGone(terminal.groupPid))
 }
})


test('retro 4: a startup whose log disappears cannot report running',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-no-log-'))
 t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const job={id:'no-log',ownership:'caller',worktree:root,model:'fixture',effort:'high',log:path.join(root,'log'),receipt:path.join(root,'receipt')}
 let running=false
 const result=await runProcess([process.execPath,'-e','setInterval(()=>{},1000)'],{cwd:root,job,timeoutMs:1000,
   onSpawn:async()=>{await fs.unlink(job.log);return []},onStarted(){running=true}})
 assert.equal(running,false);assert.notEqual(result.code,0)
 assert.notEqual(JSON.parse(await fs.readFile(job.receipt,'utf8')).status,'running')
})

test('retro 4: startup acknowledgment cannot extend the owned deadline',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-start-bound-'))
 t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const job={id:'ack-bound',ownership:'caller',worktree:root,model:'fixture',effort:'high',log:path.join(root,'log'),receipt:path.join(root,'receipt')}
 const start=Date.now()
 const result=await runProcess([process.execPath,'-e',''],{cwd:root,job,timeoutMs:400,onStarted:()=>new Promise(()=>{})})
 assert.equal(result.code,142);assert.ok(Date.now()-start<1000)
})
