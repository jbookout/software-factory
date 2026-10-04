import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeClock, never } from './helpers/deadline-and-process.mjs'
import { Deadline, waitForCondition } from '../src/deadline.mjs'

test('Codex slot queue exhaustion retains its typed refusal at every deadline boundary',async t=>{
 const {reserveCodex,acquireLease}=await import('../src/pr-delivery-state.mjs')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-slot-boundary-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const config={stateDir:root,limits:{runsPer24h:8,slots:1,timeoutMs:500},queueTimeoutMs:100,commandTimeoutMs:500,pollMs:5}
 const occupied=await acquireLease(path.join(root,'locks'),'codex-slot-0'),clock=fakeClock(),budget=new Deadline(100,{clock,phase:'queue'})
 clock.advance(100)
 try {await assert.rejects(reserveCodex(config,'fixture/repo',1,'review',budget),{code:75,cause:'slot-wait',phase:'queue'})}
 finally {await occupied()}
 const healthy=await reserveCodex(config,'fixture/repo',1,'review',new Deadline(500,{phase:'queue'}));await healthy()
})

test('admission scans stop at their queue deadline and dispose partial claims',async t=>{
 const {reserveCompute}=await import('../src/process-capacity.mjs')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-election-deadline-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const config={stateDir:root,resources:{capacity:250,browserConcurrency:1},pollMs:5}
 const clock=fakeClock(),mkdir=fs.mkdir.bind(fs)
 // Storage work consumes the queue clock without depending on host speed.
 t.mock.method(fs,'mkdir',async(...args)=>{clock.advance(1);return mkdir(...args)})
 let release,observed=false
 try {
  await assert.rejects(async()=>{release=await reserveCompute(config,1,new Deadline(50,{clock,phase:'queue'}),{snapshot:async()=>{observed=true;return []}})},{code:142})
  assert.equal(observed,false,'expired scans must not reach the process observation')
 } finally {if(release) await release()}
 for(const dir of await fs.readdir(path.join(root,'locks'))) assert.deepEqual(await fs.readdir(path.join(root,'locks',dir)),[])
 const healthy=await reserveCompute({...config,resources:{capacity:1,browserConcurrency:1}},1,new Deadline(500),{snapshot:async()=>[]});await healthy()
})

test('an observation that expires the budget cannot return a reserved slot',async t=>{
 const {reserveCompute}=await import('../src/process-capacity.mjs')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-observation-deadline-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const config={stateDir:root,resources:{capacity:1,browserConcurrency:1},pollMs:5},clock=fakeClock()
 let release
 try {await assert.rejects(async()=>{release=await reserveCompute(config,1,new Deadline(50,{clock}),{snapshot:async()=>{clock.advance(50);return []}})},{code:142})}
 finally {if(release) await release()}
 assert.deepEqual(await fs.readdir(path.join(root,'locks','compute-0.claims')),[])
})

test('standard macOS browser executable paths containing spaces consume capacity',async t=>{
 const {reserveCompute}=await import('../src/process-capacity.mjs')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-spaced-browser-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const config={stateDir:root,resources:{capacity:1,browserConcurrency:1},pollMs:5}
 let release
 const rows=[{pid:12,ppid:1,command:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless'},
 {pid:13,ppid:12,command:'/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper --type=renderer'}]
 try {await assert.rejects(async()=>{release=await reserveCompute(config,1,new Deadline(80),{snapshot:async()=>rows})},{code:142})}
 finally {if(release) await release()}
 const healthy=await reserveCompute(config,1,new Deadline(500),{snapshot:async()=>[]});await healthy()
})

test('never-settling predicate/fetch/body share one monotonic total budget', async () => {
 for (const name of ['predicate','fetch','body']) {
  const clock=fakeClock(), total=new Deadline(100,{clock})
  clock.advance(70)
  const phase=total.phaseBudget(name,80)
  const result=phase.run(never)
  clock.advance(30)
  await assert.rejects(result,{code:142,phase:'attempt'})
  assert.equal(clock.pending(),0)
 }
})
test('condition-ready avoids timers; backoff stops at provider guidance and total deadline', async () => {
 const clock=fakeClock(), budget=new Deadline(100,{clock})
 assert.equal(await waitForCondition(()=>true,{budget,ready:Boolean,pollMs:10}),true)
 assert.equal(clock.pending(),0)
 const pending=waitForCondition(()=>({retryAfterMs:200}),{budget,ready:()=>false,pollMs:10})
 await new Promise(setImmediate);clock.advance(100)
 await assert.rejects(pending,{code:142})
 assert.equal(clock.pending(),0)
})
test('capacity is atomic, counts preexisting test children, and releases all-or-nothing', async t => {
 const {reserveCompute}=await import('../src/process-capacity.mjs')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-compute-'))
 t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const observed=[{pid:123,ppid:1,command:'node --test --test-concurrency=2 suite.mjs'},
 {pid:124,ppid:123,command:'chrome --headless'}, {pid:125,ppid:124,command:'chrome --type=renderer'}]
 const config={stateDir:root,resources:{capacity:3,browserConcurrency:2},pollMs:5}
 const release=await reserveCompute(config,1,new Deadline(500),{snapshot:async()=>observed})
 await assert.rejects(reserveCompute(config,1,new Deadline(80),{snapshot:async()=>observed}),{code:142})
 await release()
 const both=await reserveCompute(config,3,new Deadline(500),{snapshot:async()=>[]})
 await assert.rejects(reserveCompute(config,1,new Deadline(80),{snapshot:async()=>[]}),{code:142})
 await both()
 assert.deepEqual(await fs.readdir(path.join(root,'locks','compute-0.claims')),[])
})
test('resource snapshot failure refuses admission and leaked reservations are not created',async t=>{
 const {reserveCompute}=await import('../src/process-capacity.mjs')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-compute-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const config={stateDir:root,resources:{capacity:2,browserConcurrency:1},pollMs:5}
 await assert.rejects(reserveCompute(config,1,new Deadline(200),{snapshot:()=>{throw Error('CANARY_PRIVATE_PS')}}),/resource observation unavailable/)
 const r=await reserveCompute(config,2,new Deadline(500),{snapshot:async()=>[]});await r()
})

test('concurrent compute contenders cannot oversubscribe and losing claims are disposed',async t=>{
 const {reserveCompute}=await import('../src/process-capacity.mjs')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-compute-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const config={stateDir:root,resources:{capacity:2,browserConcurrency:1},pollMs:5}
 const results=await Promise.allSettled([1,2].map(()=>reserveCompute(config,2,new Deadline(150),{snapshot:async()=>[]})))
 const winners=results.filter(r=>r.status==='fulfilled');assert.equal(winners.length,1)
 assert.equal(results.find(r=>r.status==='rejected').reason.code,142)
 await winners[0].value()
 const recovered=await reserveCompute(config,2,new Deadline(500),{snapshot:async()=>[]});await recovered()
})

test('preexisting child grandchildren count even after their test launcher has exited',async t=>{
 const {reserveCompute}=await import('../src/process-capacity.mjs')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-compute-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const config={stateDir:root,resources:{capacity:1,browserConcurrency:1},pollMs:5}
 const rows=[{pid:12,ppid:1,command:'/fixture/chrome --headless'},{pid:13,ppid:12,command:'/fixture/chrome --type=renderer'}]
 await assert.rejects(reserveCompute(config,1,new Deadline(80),{snapshot:async()=>rows}),{code:142})
 const free=await reserveCompute(config,1,new Deadline(500),{snapshot:async()=>[]});await free()
})

test('process arguments mentioning browsers are not classified as browser executables',async t=>{
 const {reserveCompute}=await import('../src/process-capacity.mjs')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-compute-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const config={stateDir:root,resources:{capacity:1,browserConcurrency:1},pollMs:5}
 const r=await reserveCompute(config,1,new Deadline(500),{snapshot:async()=>[{pid:12,ppid:1,command:'node model-cli prompt playwright chrome --test suite'}]})
 await r()
})

test('cancelled pacing removes its timer rather than keeping admission alive',async()=>{
 const clock=fakeClock(),controller=new AbortController(),budget=new Deadline(10000,{clock,signal:controller.signal})
 const pending=budget.sleep(9000);controller.abort()
 await assert.rejects(pending,{code:130});assert.equal(clock.pending(),0)
})

test('owned tests exceeding their reservation consume the excess before the next admission',async t=>{
 const {reserveCompute}=await import('../src/process-capacity.mjs')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-compute-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const config={stateDir:root,resources:{capacity:3,browserConcurrency:1},pollMs:5}
 const release=await reserveCompute(config,1,new Deadline(500),{snapshot:async()=>[]})
 const bindings=await release.bindJob({pid:process.pid,deadline:Date.now()+10000})
 for(const {file} of bindings){const row=JSON.parse(await fs.readFile(file));row.job.groupPid=process.pid;await fs.writeFile(file,JSON.stringify(row))}
 const rows=[{pid:process.pid,ppid:1,command:'node --test --test-concurrency=3 suite.mjs'}]
 await assert.rejects(reserveCompute(config,1,new Deadline(80),{snapshot:async()=>rows}),{code:142})
 await release()
})

test('default Node test fan-out counts its already-running workers and browser children',async t=>{
 const {reserveCompute}=await import('../src/process-capacity.mjs')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'factory-compute-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const config={stateDir:root,resources:{capacity:3,browserConcurrency:1},pollMs:5}
 const rows=[{pid:10,ppid:1,command:'node --test'}, {pid:11,ppid:10,command:'node test/one.mjs'},
 {pid:12,ppid:10,command:'node test/two.mjs'}, {pid:13,ppid:11,command:'/fixture/chrome --headless'}]
 await assert.rejects(reserveCompute(config,1,new Deadline(80),{snapshot:async()=>rows}),{code:142})
})
