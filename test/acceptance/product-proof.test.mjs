import test from 'node:test'
import assert from 'node:assert/strict'
import * as verify from '../../src/design-verify.mjs'
import { world,sha } from '../../test-support/browser-proof.mjs'
const evaluate = (w) => verify.evaluateProductProofPacket(w)
test('exact candidate packet passes only after artifact inspection',async()=>{const w=world();assert.equal((await evaluate(w)).gate,'pass')})
for(const [name,mutate] of [
 ['served wrong build',w=>w.packet.build=w.put('build.json',{binding:w.packet.binding,manifestFiles:[{path:'index.html'}],servedFiles:[{path:'other.html'}]})],
 ['native nonzero',w=>{const report=JSON.parse(w.store.get('report.json'));report.run.exitCode=1;w.packet.nativeReport=w.put('report.json',report)}],
 ['empty native exit zero',w=>{const report=JSON.parse(w.store.get('report.json'));report.run.results=[];w.packet.nativeReport=w.put('report.json',report)}],
 ['old attempt',w=>w.packet.binding.attempt=2],
 ['old run',w=>w.packet.binding.runId='run-2'],
 ['old head', w=>w.packet.binding.sourceCommit='b'.repeat(40)],
 ['wrong build', w=>w.packet.binding.buildDigest=sha('other')],
 ['wrong fixture', w=>w.packet.binding.fixtureDigest=sha('other')],
 ['wrong runtime', w=>w.packet.binding.runtime.e2e='0.15.1'],
 ['empty exit zero',w=>w.packet.coverage=w.put('coverage.json',{binding:w.packet.binding,rows:[],qualification:{broken:'failed',repaired:'passed'}})],
 ['skipped native entry',w=>w.expected.requiredNativeTests.push('unvisited-entry')],
 ['skipped required',w=>w.packet.coverage=w.put('coverage.json',{binding:w.packet.binding,rows:[{id:'draft-reload',status:'skipped',attempts:0}],qualification:{broken:'failed',repaired:'passed'}})],
 ['flaky pass',w=>w.packet.coverage=w.put('coverage.json',{binding:w.packet.binding,rows:[{id:'draft-reload',status:'passed',attempts:2}],qualification:{broken:'failed',repaired:'passed'}})],
 ['ineffective oracle',w=>w.packet.coverage=w.put('coverage.json',{binding:w.packet.binding,rows:[{id:'draft-reload',status:'passed',attempts:1}],qualification:{broken:'passed',repaired:'passed'}})],
 ['dropped write',w=>w.packet.persistence[0].readback=w.put('readback.json',{binding:w.packet.binding,phase:'reload',value:null})],
 ['same read',w=>w.packet.persistence[0].readback=w.packet.persistence[0].written],
 ['missing acknowledgement',w=>w.packet.persistence=[]],
 ['missing recording',w=>w.packet.recordings=[]],
 ['unrelated recording',w=>w.inspectRecording=async()=>({decoded:true,operationPresent:false})],
 ['empty recording',w=>w.packet.recordings[0].video=w.put('video.webm','')],
 ['corrupt recording',w=>w.inspectRecording=async()=>({decoded:false,operationPresent:false})],
 ['decoder exception',w=>w.inspectRecording=async()=>{throw Error('CANARY_SECRET')}],
 ['missing decoder',w=>delete w.inspectRecording],
 ['reader exception',w=>w.readArtifact=async()=>{throw Error('CANARY_SECRET')}],
 ['unknown result',w=>w.packet.coverage=w.put('coverage.json',{binding:w.packet.binding,rows:[{id:'draft-reload',status:'unknown',attempts:1}]})],
 ['refused result',w=>w.packet.coverage=w.put('coverage.json',{binding:w.packet.binding,rows:[{id:'draft-reload',status:'blocked',attempts:1}]})],
 ['partial read',w=>w.store.delete('readback.json')],
 ['altered bytes',w=>w.store.set('coverage.json',Buffer.from('{}'))],
 ['unsafe link',w=>w.packet.links.artifacts='https://github.com/example?token=CANARY_SECRET'],
]) test(`packet refuses ${name}`,async()=>{const w=world();mutate(w);const r=await evaluate(w);assert.notEqual(r.gate,'pass');assert.ok(r.reasons.length);assert.doesNotMatch(JSON.stringify(r),/CANARY_SECRET/)})
test('an empty required manifest refuses instead of authorizing empty proof',async()=>{const w=world();w.expected.requiredCoverage=[];assert.notEqual((await evaluate(w)).gate,'pass')})

for(const value of [null,{},[],undefined]) test(`malformed packet ${JSON.stringify(value)} refuses`,async()=>{const w=world();w.packet=value;assert.notEqual((await evaluate(w)).gate,'pass')})
test('data snapshot resists mutation while reading artifacts',async()=>{const w=world();const read=w.readArtifact;w.readArtifact=async ref=>{w.packet.binding.sourceCommit='b'.repeat(40);return read(ref)};assert.equal((await evaluate(w)).gate,'pass')})

test('review findings and reproduction minutes bind the exact first-review head',()=>{const input={repo:'jbookout/doctorcre-app',sourceCommit:'a'.repeat(40),reviewedSha:'a'.repeat(40),commentUrl:'https://github.com/jbookout/doctorcre-app/pull/123#issuecomment-456',firstReviewUiFindings:2,reproductionMinutes:3.5};assert.equal(verify.productProofReviewMetrics(input).reproductionMinutes,3.5);for(const change of [{reviewedSha:'b'.repeat(40)},{firstReviewUiFindings:-1},{reproductionMinutes:NaN},{commentUrl:'https://user:CANARY_SECRET@example.com'}]) assert.throws(()=>verify.productProofReviewMetrics({...input,...change}),/invalid exact-head/)})

test('raw refusal never echoes malformed expected identity or reader errors',async()=>{const w=world();w.expected.sourceCommit='CANARY_SECRET';const result=await evaluate(w);assert.equal(result.sourceCommit,null);assert.doesNotMatch(JSON.stringify(result),/CANARY_SECRET/)})
for(const invalid of [{},null,42]) test(`malformed native report result ${JSON.stringify(invalid)} refuses`,async()=>{const w=world();w.packet.nativeReport=w.put('report.json',{schemaVersion:'report-1',run:{results:invalid,targets:invalid}});assert.notEqual((await evaluate(w)).gate,'pass')})

test('native report from another same-head run refuses',async()=>{const w=world();const report=JSON.parse(w.store.get('report.json'));report.run.id='run-2';w.packet.nativeReport=w.put('report.json',report);assert.equal((await evaluate(w)).gate,'fail')})

// Blocking review reproductions: each mutation changes inspected bytes and its
// candidate digest, preserving the independently selected expected identity.
const artifactJson=(w,key,mutate)=>{const ref=w.packet[key].ref,value=JSON.parse(w.store.get(ref));mutate(value);w.packet[key]=w.put(ref,value)}
for(const [finding,name,mutate] of [
 [1,'null served manifest',w=>artifactJson(w,'build',b=>b.manifestFiles=b.servedFiles=[null])],
 [1,'equal invented served manifest',w=>artifactJson(w,'build',b=>b.manifestFiles=b.servedFiles=[{path:'unarchived.html',sha256:sha('invented')}])],
 [2,'failed terminal attempt',w=>artifactJson(w,'nativeReport',r=>r.run.results[0].attempts=[{status:'failed',error:{message:'failure'}}])],
 [2,'array-like attempts',w=>artifactJson(w,'nativeReport',r=>r.run.results[0].attempts={length:1})],
 [2,'failed nested step',w=>artifactJson(w,'nativeReport',r=>r.run.results[0].attempts=[{status:'passed',steps:[{status:'failed',error:{message:'failure'}}]}])],
 [2,'missing binding and VCS',w=>{delete w.packet.binding.sourceCommit;artifactJson(w,'nativeReport',r=>delete r.run.vcs)}],
 [3,'unqualified selected target',w=>artifactJson(w,'nativeReport',r=>r.run.results[0].targetId='firefox')],
 [3,'contradictory target',w=>artifactJson(w,'nativeReport',r=>r.run.targets.push({id:'chromium',platform:'mobile',engine:{name:'web',version:'0.11.2'}}))],
 [4,'continuity label without execution',w=>{w.expected.requiredCoverage.push('continuity-320-reduce');artifactJson(w,'coverage',c=>c.rows.push({id:'continuity-320-reduce',status:'passed',attempts:1}))}],
 [4,'qualification labels without execution',w=>artifactJson(w,'coverage',c=>c.qualification={broken:'failed',repaired:'passed'})],
 [5,'equal null persistence',w=>{for(const key of ['written','readback']) {const ref=w.packet.persistence[0][key].ref;const value=JSON.parse(w.store.get(ref));value.value=null;w.packet.persistence[0][key]=w.put(ref,value)}}],
 [5,'reused persistence observations',w=>{w.expected.requiredPersistence.push('second-save');w.expected.persistenceIntent['second-save']=structuredClone(w.expected.persistenceIntent['draft-reload']);w.packet.persistence.push({...w.packet.persistence[0],id:'second-save'})}],
 [6,'new run with old recording bytes',w=>{w.expected.runId=w.packet.binding.runId='run-2';for(const key of ['build','coverage'])artifactJson(w,key,b=>b.binding=w.packet.binding);artifactJson(w,'nativeReport',r=>r.run.id='run-2');for(const row of w.packet.persistence)for(const key of ['written','readback']){const v=JSON.parse(w.store.get(row[key].ref));v.binding=w.packet.binding;row[key]=w.put(row[key].ref,v)}}],
]) test(`review ${finding}: refuses ${name}`,async()=>{const w=world();mutate(w);assert.equal((await evaluate(w)).gate,'fail')})
test('review 10: a late inspector result cannot pass',async()=>{const w=world();w.limits={timeoutMs:20};w.inspectRecording=async()=>{await new Promise(r=>setTimeout(r,60));return {decoded:true,operationPresent:true}};assert.equal((await evaluate(w)).gate,'fail')})
test('review 10: an unsettled inspector is cancelled at the shared deadline',async()=>{const w=world();w.limits={timeoutMs:20};w.inspectRecording=()=>new Promise(()=>{});const result=await Promise.race([evaluate(w),new Promise(resolve=>setTimeout(()=>resolve({gate:'hung'}),120))]);assert.equal(result.gate,'fail')})
test('review 2: malformed result with otherwise valid targets returns refusal',async()=>{const w=world();artifactJson(w,'nativeReport',r=>r.run.results=[null]);assert.equal((await evaluate(w)).gate,'fail')})
test('review 2: sparse required recording manifest returns refusal',async()=>{const w=world();w.expected.requiredRecordings=Array(1);assert.equal((await evaluate(w)).gate,'fail')})
test('native and separate continuity coverage each require their independently selected execution',async()=>{
  const w=world();w.expected.requiredCoverage.push('w01-shell');w.expected.coverageEvidence['w01-shell']={kind:'native',testIds:['test-1']}
  artifactJson(w,'coverage',c=>c.rows.push({id:'w01-shell',status:'passed',attempts:1,testIds:['test-1']}))
  assert.equal((await evaluate(w)).gate,'pass')
  artifactJson(w,'coverage',c=>c.rows.find(row=>row.id==='w01-shell').testIds=['other-test'])
  assert.equal((await evaluate(w)).gate,'fail')
})
test('review 6: refreshing every nonrecording execution still refuses an old recording',async()=>{
  const w=world();w.expected.runId=w.packet.binding.runId='run-2'
  const refresh=ref=>{const value=JSON.parse(w.store.get(ref.ref));value.binding=w.packet.binding;return w.put(ref.ref,value)}
  w.expected.coverageEvidence['draft-reload'].report=refresh(w.expected.coverageEvidence['draft-reload'].report)
  for(const role of ['broken','repaired']) w.expected.qualification[role].report=refresh(w.expected.qualification[role].report)
  artifactJson(w,'build',b=>b.binding=w.packet.binding)
  artifactJson(w,'nativeReport',r=>r.run.id='run-2')
  artifactJson(w,'coverage',c=>{c.binding=w.packet.binding;c.rows[0].report=w.expected.coverageEvidence['draft-reload'].report;c.qualification={broken:{report:w.expected.qualification.broken.report},repaired:{report:w.expected.qualification.repaired.report}}})
  for(const key of ['written','readback']) w.packet.persistence[0][key]=refresh(w.packet.persistence[0][key])
  const result=await evaluate(w)
  assert.equal(result.gate,'fail');assert.deepEqual(result.reasons,['artifact run/build binding mismatch','recording provenance differs: draft-reload'])
})
