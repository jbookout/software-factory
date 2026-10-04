import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createPrDeliveryAdapter} from '../src/pr-delivery.mjs'
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'proof-delivery-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const head='a'.repeat(40),repo='jbookout/doctorcre-app',state=join(root,'pr.json')
  await writeFile(state,JSON.stringify({head,base:'main',status:'success',state:'open'}))
  await writeFile(join(root,'gh'),`#!/usr/bin/env node
const fs=require('fs'),s=JSON.parse(fs.readFileSync(${JSON.stringify(state)})),route=process.argv[3];
let result;
if(route.includes('/comments') || route.includes('/statuses')) result=[];
else if(route.includes('/check-runs')) result={total_count:1,check_runs:[{id:1,name:'test',head_sha:s.head,status:'completed',conclusion:s.status,app:{id:15368}}]};
else result={number:14,state:s.state,head:{sha:s.head,ref:'topic',repo:{full_name:'${repo}'}},base:{ref:s.base,repo:{full_name:'${repo}'}},mergeable:true};
console.log('HTTP/2.0 200 OK\\n\\n'+JSON.stringify(result));`,{mode:0o755})
  const gitCalls=join(root,'git-calls')
  await writeFile(join(root,'git'),`#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(gitCalls)},JSON.stringify(process.argv)+'\\n');process.exit(1);`,{mode:0o755})
  const config={repos:{[repo]:{checkout:root,worktreeRoot:join(root,'wt'),requiredChecks:[{name:'test'}],productProofRequired:true}},stateDir:join(root,'state'),commandTimeoutMs:5000,checksTimeoutMs:5000}
  const adapter=intake=>createPrDeliveryAdapter(config,{env:{...process.env,PATH:root+':'+process.env.PATH},productProofIntake:intake})
  return {root,head,repo,state,gitCalls,adapter,config}
}
for(const outcome of [undefined,{gate:'fail'}, {gate:'pass',sourceCommit:'b'.repeat(40)},new Error('CANARY_SECRET CANARY_CLIENT_IDENTIFIER')]) test(`delivery refuses unproven candidate ${outcome?.gate??'missing'}`,async t=>{
  const f=await fixture(t)
  const result=await f.adapter(async()=>{if(outcome instanceof Error) throw outcome;return outcome}).execute('review',{repo:f.repo,pr:14})
  assert.equal(result.status,'fail');assert.match(JSON.stringify(result),/PRODUCT-PROOF-REFUSED/)
  const persisted=await readFile(join(f.root,'state/delivery.jsonl'),'utf8')
  assert.doesNotMatch(persisted,/CANARY_SECRET|CANARY_CLIENT_IDENTIFIER/)
  await assert.rejects(readFile(f.gitCalls),{code:'ENOENT'})
})
for(const change of [{head:'b'.repeat(40)},{base:'other'},{state:'closed'},{status:'cancelled'}]) test(`review 9: intake refresh refuses ${JSON.stringify(change)} before Git or budget effects`,async t=>{
  const f=await fixture(t)
  const result=await f.adapter(async()=>{await writeFile(f.state,JSON.stringify({head:f.head,base:'main',status:'success',state:'open',...change}));return {gate:'pass',sourceCommit:f.head}}).execute('review',{repo:f.repo,pr:14})
  assert.equal(result.status,'fail')
  await assert.rejects(readFile(f.gitCalls),{code:'ENOENT'})
  await assert.rejects(readFile(join(f.root,'state/usage.json')),{code:'ENOENT'})
})

test('default configured delivery intake admits valid inspected proof before reaching Git',async t=>{
  const {proofStore}=await import('../test-support/product-proof-store.mjs')
  const w=await proofStore(t),f=await fixture(t)
  f.config.repos[f.repo].productProof={artifactRoot:w.artifactRoot,expectedRoot:w.expectedRoot}
  const result=await f.adapter().execute('review',{repo:f.repo,pr:14})
  assert.equal(result.status,'fail') // the fixture deliberately refuses the Git effect
  assert.doesNotMatch(JSON.stringify(result),/PRODUCT-PROOF-REFUSED/)
  assert.match(await readFile(f.gitCalls,'utf8'),/fetch/)
})
