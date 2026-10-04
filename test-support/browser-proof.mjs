import { createHash } from 'node:crypto'
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export function tar(entries) {
  const chunks=[]
  for(const [path,content] of entries) {
    const data=Buffer.from(content),header=Buffer.alloc(512)
    header.write(path,0,100);header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116)
    header.write(data.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136)
    header.fill(32,148,156);header.write('0',156);header.write('ustar\0',257);header.write('00',263)
    header.write([...header].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148)
    chunks.push(header,data,Buffer.alloc((512-data.length%512)%512))
  }
  return Buffer.concat([...chunks,Buffer.alloc(1024)])
}
export const successfulAttempt=()=>({id:'attempt-1',index:0,status:'passed',cleanup:'complete',secondaryErrors:[],steps:[{id:'step-1',index:0,status:'passed',api:'expect.toHaveText',events:[],artifacts:[]}]})
export function world() {
  const store=new Map()
  const put=(ref,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value));store.set(ref,bytes);return {ref,digest:sha(bytes)}}
  const files=[{path:'index.html',sha256:sha('page'),bytes:4}]
  const manifest={schema:'browser-build-manifest.v1',source_commit:'a'.repeat(40),files}
  const archive=tar([['artifact-manifest.json',JSON.stringify(manifest)],['index.html','page']])
  const binding={repo:'jbookout/doctorcre-app',sourceCommit:'a'.repeat(40),buildDigest:sha(archive),buildConfigDigest:sha('config'),fixtureDigest:sha('fixture'),runtime:{e2e:'0.16.0',web:'0.11.2',playwright:'1.63.0',node:'22.12.0',browser:'chromium'},runId:'run-1',attempt:1}
  const native={schemaVersion:'report-1',run:{id:'run-1',environment:{runtime:'node v22.12.0'},targets:[{id:'chromium',platform:'web',engine:{name:'web',version:'0.11.2'}}],runner:{version:'0.16.0'},vcs:{commit:binding.sourceCommit,dirty:false},exitCode:0,status:'passed',errors:[],results:[{testId:'test-1',file:'tests/journeys/w01-shell.e2e.ts',targetId:'chromium',platform:'web',selected:true,status:'passed',attempts:[successfulAttempt()]}]}}
  const execution=(id,status)=>({schema:'browser-execution.v1',binding,runner:'node:test',testId:id,targetId:'chromium',platform:'web',status,attempts:[{...successfulAttempt(),status,steps:[{id:'oracle-1',index:0,api:'assert.persistence',status,...(status==='failed'?{error:{message:'deciding violation'}}:{})}],...(status==='failed'?{error:{message:'deciding violation'}}:{})}],oracle:{id:'draft-value',expected:'Demo draft',observed:status==='failed'?null:'Demo draft',violation:status==='failed'?'lost-draft':null}})
  const continuity=put('continuity.json',execution('draft-reload','passed'))
  const broken=put('broken.json',execution('broken-draft','failed')),repaired=put('repaired.json',execution('repaired-draft','passed'))
  const qualification={broken:{report:broken},repaired:{report:repaired}}
  const subject={storage:'localStorage',key:'draft',operation:'setItem'}
  const packet={schema:'browser-product-proof.v2',binding,buildArchive:put('build.tar',archive),build:put('build.json',{binding,manifestFiles:files,servedFiles:files}),nativeReport:put('report.json',native),coverage:put('coverage.json',{binding,rows:[{id:'draft-reload',status:'passed',attempts:1,report:continuity}],qualification}),persistence:[{id:'draft-reload',written:put('written.json',{binding,id:'draft-reload',subject,phase:'write',value:'Demo draft'}),readback:put('readback.json',{binding,id:'draft-reload',subject,phase:'reload',value:'Demo draft'})}],recordings:[{id:'draft-reload',operation:'save-reload',video:put('video.webm','video bytes'),trace:put('trace.zip','trace bytes'),checkpoint:put('checkpoint.png','image bytes')}],links:{run:'https://github.com/jbookout/doctorcre-app/actions/runs/123',artifacts:'https://github.com/jbookout/doctorcre-app/actions/runs/123/artifacts/456'},metrics:{firstReviewUiFindings:null,reproductionMinutes:null}}
  const recording=packet.recordings[0]
  const provenance=put('recording.json',{schema:'browser-recording.v1',binding,id:recording.id,testId:'draft-reload',execution:continuity,targetId:'chromium',platform:'web',attemptId:'attempt-1',pageId:'page-1',contextId:'context-1',videoStartTime:0,checkpointTime:1500,video:recording.video,trace:recording.trace,checkpoint:recording.checkpoint})
  recording.provenance=provenance
  const expected={...binding,requiredNativeTests:['test-1'],requiredCoverage:['draft-reload'],coverageEvidence:{'draft-reload':{kind:'continuity',report:continuity,testId:'draft-reload',oracle:{id:'draft-value',expected:'Demo draft'}}},qualification:{broken:{report:broken,testId:'broken-draft',oracle:{id:'draft-value',expected:'Demo draft',violation:'lost-draft'}},repaired:{report:repaired,testId:'repaired-draft',oracle:{id:'draft-value',expected:'Demo draft'}}},requiredPersistence:['draft-reload'],persistenceIntent:{'draft-reload':{subject,value:'Demo draft'}},requiredRecordings:[{id:'draft-reload',operation:'save-reload',provenance}]}
  return {packet,expected,readArtifact:async ref=>store.get(ref),inspectRecording:async()=>({decoded:true,operationPresent:true}),put,store}
}
