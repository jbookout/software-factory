import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as verify from '../../src/design-verify.mjs'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function world() {
  const store = new Map()
  const put = (ref, value) => { const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value)); store.set(ref,bytes); return {ref,digest:sha(bytes)} }
  const identity = {repo:'jbookout/doctorcre-app',sourceCommit:'a'.repeat(40),buildDigest:sha('build'),buildConfigDigest:sha('config'),fixtureDigest:sha('fixture'),runtime:{e2e:'0.16.0',web:'0.11.2',playwright:'1.63.0',node:'22.12.0',browser:'chromium'}}
  const binding = {...identity,runId:'run-1',attempt:1}
  const packet = {schema:'browser-product-proof.v1',binding,coverage:put('coverage.json',{binding,rows:[{id:'draft-reload',status:'passed',attempts:1}],qualification:{broken:'failed',repaired:'passed'}}),build:put('build.json',{binding,manifestFiles:[{path:'index.html',sha256:sha('page')}],servedFiles:[{path:'index.html',sha256:sha('page')}]}),buildArchive:put('build.tar','build'),nativeReport:put('report.json',{schemaVersion:'report-1',run:{id:'run-1',environment:{runtime:'node v22.12.0'},targets:[{id:'chromium',engine:{name:'web',version:'0.11.2'}}],runner:{version:'0.16.0'},vcs:{commit:identity.sourceCommit,dirty:false},exitCode:0,status:'passed',results:[{testId:'test-1',selected:true,status:'passed',attempts:[{}]}]}}),persistence:[{id:'draft-reload',written:put('written.json',{binding,phase:'write',value:'Demo draft'}),readback:put('readback.json',{binding,phase:'reload',value:'Demo draft'})}],recordings:[{id:'draft-reload',video:put('video.webm','video bytes'),trace:put('trace.zip','trace bytes'),checkpoint:put('checkpoint.png','image bytes'),operation:'save-reload'}],links:{run:'https://github.com/jbookout/doctorcre-app/actions/runs/123',artifacts:'https://github.com/jbookout/doctorcre-app/actions/runs/123/artifacts/456'},metrics:{firstReviewUiFindings:null,reproductionMinutes:null}}
  return {packet,expected:{...identity,runId:'run-1',attempt:1,requiredNativeTests:['test-1'],requiredCoverage:['draft-reload'],requiredPersistence:['draft-reload'],requiredRecordings:[{id:'draft-reload',operation:'save-reload'}]},readArtifact:async ref=>store.get(ref),inspectRecording:async()=>({decoded:true,operationPresent:true}),put,store}
}
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
