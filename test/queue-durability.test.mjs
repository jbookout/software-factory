import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { writeJson, readJson, reserveCodex, orphanLeaseCount } from '../src/pr-delivery-state.mjs'
import * as evidence from '../src/evidence.mjs'
const deliveryEffectId = evidence.deliveryEffectId
import { Deadline } from '../src/deadline.mjs'

for (const fault of ['partial-write','file-sync','rename','directory-sync']) test(`durable queue publication: ${fault} never acknowledges partial bytes`, async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'queue-durability-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const file=path.join(root,'queue.json');await writeJson(file,{jobs:['prior']})
 const open=fs.open.bind(fs)
 if(fault==='rename') t.mock.method(fs,'rename',async()=>{throw Object.assign(Error('synthetic publication failure'),{code:'ENOSPC'})})
 else t.mock.method(fs,'open',async(...args)=>{
  const handle=await open(...args)
  if(args[0].endsWith('.tmp')&&fault==='partial-write') {
   const write=handle.writeFile.bind(handle)
   handle.writeFile=async()=>{await write('{"jobs":');throw Object.assign(Error('synthetic partial write'),{code:'ENOSPC'})}
  }
  if(args[0].endsWith('.tmp')&&fault==='file-sync'||args[0]===root&&fault==='directory-sync')
   handle.sync=async()=>{throw Object.assign(Error('synthetic fsync failure'),{code:'EIO'})}
  return handle
 })
 await assert.rejects(writeJson(file,{jobs:['next']}))
 assert.deepEqual(await readJson(file),{jobs:[fault==='directory-sync'?'next':'prior']})
 assert.deepEqual(await fs.readdir(root),['queue.json'],'failed unpublished temporary bytes are disposed')
 t.mock.restoreAll();await writeJson(file,{jobs:['recovered']});assert.deepEqual(await readJson(file),{jobs:['recovered']})
})
test('effect identity retains retries and separates each semantic binding and explicit rerun',()=>{
 const binding={repo:'fixture/repo',pr:7,head:'a'.repeat(40),action:'merge'}
 const id=deliveryEffectId(binding);assert.equal(deliveryEffectId({...binding}),id)
 for(const mutation of [{repo:'fixture/other'},{pr:8},{head:'b'.repeat(40)},{action:'comment'},{policy:'next'},{attempt:2}])
  assert.notEqual(deliveryEffectId({...binding,...mutation}),id)
 for(const mutation of [{pr:0},{head:'short'},{action:''},{attempt:0},{repo:'../other'}])
  assert.throws(()=>deliveryEffectId({...binding,...mutation}))
})
test('cancelled budget admission consumes no slot or spending record after capacity frees',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'queue-budget-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const config={stateDir:root,limits:{runsPer24h:1,slots:1,timeoutMs:1000},pollMs:1,commandTimeoutMs:1000}
 const stop=Object.assign(Error('cancelled'),{code:130})
 await assert.rejects(reserveCodex(config,'fixture/repo',7,'review',new Deadline(1000),{beforeAdmission:async()=>{throw stop}}),{code:130})
 await assert.rejects(fs.access(path.join(root,'usage.json')),{code:'ENOENT'})
 const healthy=await reserveCodex(config,'fixture/repo',7,'review',new Deadline(1000))
 try {assert.equal((await readJson(path.join(root,'usage.json')))[0].attemptId,healthy.attemptId)} finally {await healthy()}
})

test('orphan diagnostics read abandoned claims; successor recovery clears them',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'queue-orphans-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const claims=path.join(root,'pr-fixture.claims');await fs.mkdir(claims)
 await writeJson(path.join(claims,'dead.json'),{pid:2147483647,token:'dead',ticket:1})
 assert.equal(await orphanLeaseCount(root),1)
 const {acquireLease}=await import('../src/pr-delivery-state.mjs');const release=await acquireLease(root,'pr-fixture')
 assert.equal(await orphanLeaseCount(root),0);await release()
})
test('malformed private state cannot publish source bytes in its error',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'queue-private-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const file=path.join(root,'queue.json');await fs.writeFile(file,'CANARY_PRIVATE_QUEUE_CLIENT_SECRET')
 await assert.rejects(readJson(file),error=>{assert.equal(error.code,9);assert.doesNotMatch(error.message,/CANARY_PRIVATE/);return true})
})
