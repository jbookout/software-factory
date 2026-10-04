import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {runProcess} from '../src/process-runner.mjs'
import {world} from '../test-support/browser-proof.mjs'
const cli=new URL('../bin/browser-product-proof.mjs',import.meta.url).pathname
for(const entry of ['cli','configured']) test(`review 8: ${entry} refuses an initial FIFO without waiting for a writer`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'proof-input-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const w=world(),key=w.expected.repo.replace('/','--'),head=w.expected.sourceCommit
  const store=join(root,'artifacts',key,head),expectedRoot=join(root,'expected'),expectedFile=join(expectedRoot,key,`${head}.json`)
  await mkdir(store,{recursive:true});await mkdir(join(expectedRoot,key),{recursive:true});await writeFile(expectedFile,JSON.stringify(w.expected))
  execFileSync('mkfifo',[join(store,'packet.json')])
  const config={repos:{[w.expected.repo]:{productProof:{artifactRoot:join(root,'artifacts'),expectedRoot}}}}
  const argv=entry==='cli'?[process.execPath,cli,store,join(store,'packet.json'),expectedFile]:[process.execPath,'--input-type=module','-e',`import {createConfiguredProductProofIntake} from ${JSON.stringify(new URL('../src/product-proof-intake.mjs',import.meta.url).href)};console.log(JSON.stringify(await createConfiguredProductProofIntake(${JSON.stringify(config)})(${JSON.stringify({repo:w.expected.repo,head})})))`]
  const result=await runProcess(argv,{timeoutMs:1500})
  assert.equal(result.timedOut,false);assert.equal(JSON.parse(result.stdout).gate,'fail')
})
test('review 11: shared qualified policy reads initial inputs and rejects oversized JSON',async t=>{
  const {evaluateProductProofFiles}=await import('../src/product-proof-policy.mjs')
  const root=await mkdtemp(join(tmpdir(),'proof-input-'));t.after(()=>rm(root,{recursive:true,force:true}))
  await writeFile(join(root,'packet.json'),JSON.stringify({padding:'x'.repeat(1024*1024)}))
  await writeFile(join(root,'expected.json'),'{}')
  assert.equal((await evaluateProductProofFiles({store:root,packetFile:join(root,'packet.json'),expectedFile:join(root,'expected.json')})).gate,'fail')
})
test('qualified CLI and default configured intake both inspect and accept the complete packet',async t=>{
  const {proofStore}=await import('../test-support/product-proof-store.mjs')
  const {createConfiguredProductProofIntake}=await import('../src/product-proof-intake.mjs')
  const w=await proofStore(t),config={repos:{[w.expected.repo]:{productProof:{artifactRoot:w.artifactRoot,expectedRoot:w.expectedRoot}}}}
  const intake=createConfiguredProductProofIntake(config)
  assert.equal((await intake({repo:w.expected.repo,head:w.expected.sourceCommit})).gate,'pass')
  const result=await runProcess([process.execPath,cli,w.store,w.packetFile,w.expectedFile],{timeoutMs:10_000})
  assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).gate,'pass')
  const refusal=await intake({repo:w.expected.repo,head:'b'.repeat(40)})
  assert.equal(refusal.gate,'fail')
  await writeFile(w.packetFile,JSON.stringify({...w.packet,padding:'x'.repeat(1024*1024)}))
  const oversized=await intake({repo:w.expected.repo,head:w.expected.sourceCommit})
  assert.equal(oversized.gate,'fail');assert.deepEqual(oversized.reasons,['product proof input unavailable'])
  const oversizedCli=await runProcess([process.execPath,cli,w.store,w.packetFile,w.expectedFile],{timeoutMs:10_000})
  assert.equal(oversizedCli.code,1);assert.deepEqual(JSON.parse(oversizedCli.stdout).reasons,oversized.reasons)
})
