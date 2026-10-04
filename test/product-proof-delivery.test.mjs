import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createPrDeliveryAdapter} from '../src/pr-delivery.mjs'

// Reach the installed delivery adapter, not a parallel predicate. Its GH read
// is synthetic; no paid process or public comment is permitted by this fixture.
for(const outcome of [undefined,{gate:'fail'}, {gate:'pass',sourceCommit:'b'.repeat(40)},new Error('CANARY_SECRET CANARY_CLIENT_IDENTIFIER')]) test(`delivery refuses unproven candidate ${outcome?.gate??'missing'}`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'proof-delivery-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const head='a'.repeat(40)
  await writeFile(join(root,'gh'),`#!/usr/bin/env node\nconsole.log(JSON.stringify({state:'OPEN',baseRefName:'main',headRefOid:'${head}',statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}]}))`,{mode:0o755})
  const config={repos:{'jbookout/doctorcre-app':{checkout:root,worktreeRoot:join(root,'wt'),productProofRequired:true}},stateDir:join(root,'state'),commandTimeoutMs:5000,checksTimeoutMs:5000}
  const adapter=createPrDeliveryAdapter(config,{env:{...process.env,PATH:root+':'+process.env.PATH},productProofIntake:async()=>{if(outcome instanceof Error) throw outcome; return outcome}})
  const result=await adapter.execute('review',{repo:'jbookout/doctorcre-app',pr:14})
  assert.equal(result.status,'fail');assert.match(JSON.stringify(result),/PRODUCT-PROOF-REFUSED/)
  const persisted=await readFile(join(root,'state/delivery.jsonl'),'utf8')
  assert.doesNotMatch(persisted,/CANARY_SECRET|CANARY_CLIENT_IDENTIFIER/)
})
