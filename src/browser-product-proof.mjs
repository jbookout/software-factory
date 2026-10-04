// Expected identity, execution hashes and intended values are orchestrator-owned.
// Candidate labels select nothing: all deciding evidence is inspected here.
import { isDeepStrictEqual } from 'node:util'
import { createBoundReader, evidenceReadLimits } from './evidence.mjs'
import { inspectBuildArchive } from './browser-build-archive.mjs'

export const PRODUCT_PROOF_RUNTIME = Object.freeze({e2e:'0.16.0',web:'0.11.2',playwright:'1.63.0',browser:'chromium'})
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const names = value => Array.isArray(value) && Array.from(value).every(id=>typeof id==='string' && id.length>0) && new Set(value).size===value.length
const ids = value => names(value) && value.every(id=>/^[a-z0-9-]+$/.test(id))
const reference = value => typeof value?.ref==='string' && value.ref.length>0 && digest(value.digest)
const identityKeys = ['repo','sourceCommit','buildDigest','buildConfigDigest','fixtureDigest','runtime','runId','attempt']
const identity = value => typeof value?.repo==='string' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value.repo) &&
  /^[0-9a-f]{40}$/.test(value.sourceCommit??'') && ['buildDigest','buildConfigDigest','fixtureDigest'].every(key=>digest(value[key])) &&
  typeof value.runId==='string' && /^[a-zA-Z0-9-]+$/.test(value.runId) && Number.isSafeInteger(value.attempt) && value.attempt>0 &&
  Object.entries(PRODUCT_PROOF_RUNTIME).every(([key,required])=>value.runtime?.[key]===required) && /^v?\d+\.\d+\.\d+$/.test(value.runtime?.node??'')
const sameIdentity=(a,b)=>identityKeys.every(key=>isDeepStrictEqual(a?.[key],b?.[key]))
const safeLink = (value, repo) => typeof value === 'string' && new RegExp(`^https://github\\.com/${repo.replaceAll('.', '\\.')}\\/actions/runs/[0-9]+(?:/artifacts/[0-9]+)?$`).test(value)
const noError=value=>value?.error===undefined && value?.failure===undefined && value?.skip===undefined
const error=value=>value && typeof value==='object' && typeof value.message==='string' && value.message.length>0

function validAttempt(attempt,outcome='passed') {
  if(!attempt || typeof attempt.id!=='string' || !attempt.id || attempt.index!==0 || attempt.status!==outcome ||
     attempt.cleanup!=='complete' || !Array.isArray(attempt.secondaryErrors) || attempt.secondaryErrors.length ||
     !Array.isArray(attempt.steps) || !attempt.steps.length || !names(attempt.steps.map(step=>step?.id))) return false
  if(outcome==='passed' && !noError(attempt) || outcome==='failed' && !error(attempt.error)) return false
  const failed=[]
  for(const [index,step] of attempt.steps.entries()) {
    if(step.index!==index || typeof step.api!=='string' || !step.api || !['passed','failed'].includes(step.status)) return false
    if(step.status==='passed' && !noError(step) || step.status==='failed' && !error(step.error)) return false
    if(step.status==='failed') failed.push(step)
  }
  return outcome==='passed' ? failed.length===0 : failed.length===1 && failed[0]===attempt.steps.at(-1)
}
const successfulResult=row=>row?.selected===true && row.status==='passed' && noError(row) &&
  row.targetId==='chromium' && row.platform==='web' && Array.isArray(row.attempts) && row.attempts.length===1 && validAttempt(row.attempts[0])
const validOracle=oracle=>typeof oracle?.id==='string' && oracle.id.length>0 && Object.hasOwn(oracle,'expected')

export async function evaluateProductProofPacket(input) {
  const reasons=[]
  let packet,expected,limits
  try { ({packet,expected}=structuredClone({packet:input.packet,expected:input.expected}));limits=evidenceReadLimits(input.limits) }
  catch {return {gate:'fail',reasons:['malformed product proof input'],sourceCommit:null}}
  const deadline=input.deadline===undefined?Date.now()+limits.timeoutMs:Math.min(input.deadline,Date.now()+limits.timeoutMs)
  const finish=()=>({gate:reasons.length?'fail':'pass',reasons,sourceCommit:/^[0-9a-f]{40}$/.test(expected?.sourceCommit??'')?expected.sourceCommit:null})
  const binding=packet?.binding
  if(packet?.schema!=='browser-product-proof.v2' || !identity(binding) || !identity(expected) || !sameIdentity(binding,expected) ||
     !ids(expected.requiredCoverage) || !expected.requiredCoverage.length || !names(expected.requiredNativeTests) || !expected.requiredNativeTests.length ||
     !ids(expected.requiredPersistence) || !Array.isArray(expected.requiredRecordings) || !ids(expected.requiredRecordings.map(row=>row?.id)) ||
     expected.requiredRecordings.some(row=>row.operation!=='save-reload' || !reference(row.provenance))) {
    reasons.push('malformed packet, identity or required manifest');return finish()
  }
  if(!packet.metrics || packet.metrics.firstReviewUiFindings!==null && (!Number.isSafeInteger(packet.metrics.firstReviewUiFindings) || packet.metrics.firstReviewUiFindings<0) ||
     packet.metrics.reproductionMinutes!==null && (!Number.isFinite(packet.metrics.reproductionMinutes) || packet.metrics.reproductionMinutes<0)) reasons.push('invalid review metrics')
  if(!packet.links || !['run','artifacts'].every(key=>safeLink(packet.links[key],expected.repo)) || packet.links.run.includes('/artifacts/') ||
     ![packet.links.run,packet.links.run+'/artifacts/'+packet.links.artifacts.split('/').at(-1)].includes(packet.links.artifacts)) reasons.push('unsafe or missing artifact links')
  if(typeof input.readArtifact!=='function' || !Number.isFinite(deadline) || deadline<=Date.now()) {reasons.push('missing artifact reader or expired deadline');return finish()}
  const read=createBoundReader({readArtifact:input.readArtifact,limits:{...limits,timeoutMs:Math.max(1,deadline-Date.now())}})
  async function bytes(ref) {
    const result=await read(ref)
    if(!result.bytes) {reasons.push('missing, empty, unreadable or altered artifact');return null}
    return result.bytes
  }
  async function json(ref,bound=true) {
    const data=await bytes(ref);if(!data) return null
    try {
      const result=JSON.parse(data)
      if(bound && !isDeepStrictEqual(result?.binding,binding)) {reasons.push('artifact run/build binding mismatch');return null}
      return result
    } catch {reasons.push('malformed artifact JSON');return null}
  }
  // Archive hash comes from expected identity; the manifest is derived from
  // those exact bytes, including checking every payload hash and file size.
  const archive=await bytes(packet.buildArchive),build=await json(packet.build)
  try {
    if(!archive || packet.buildArchive?.digest!==expected.buildDigest) throw Error('archive binding')
    const authenticated=inspectBuildArchive(archive,expected.sourceCommit)
    if(!isDeepStrictEqual(build?.manifestFiles,authenticated.files) || !isDeepStrictEqual(build?.servedFiles,authenticated.files)) throw Error('served files differ')
  } catch {reasons.push('served build differs from authenticated archive')}
  const native=await json(packet.nativeReport,false),run=native?.run
  const nativeResults=Array.isArray(run?.results)?run.results:[]
  const targets=Array.isArray(run?.targets)?run.targets:[]
  if(native?.schemaVersion!=='report-1' || run?.runner?.version!==PRODUCT_PROOF_RUNTIME.e2e || run?.id!==binding.runId ||
     run?.vcs?.commit!==binding.sourceCommit || run?.vcs?.dirty!==false || run?.exitCode!==0 || run?.status!=='passed' ||
     !Array.isArray(run?.errors) || run.errors.length || !nativeResults.length || !names(nativeResults.map(row=>row?.testId)) ||
     nativeResults.some(row=>typeof row?.selected!=='boolean' || row.selected && !successfulResult(row))) reasons.push('native e2e result is empty, stale, malformed or not successful')
  if(run?.environment?.runtime!==`node v${binding.runtime.node}` || !names(targets.map(row=>row?.id)) ||
     !targets.some(row=>row.id==='chromium' && row.platform==='web' && row.engine?.name==='web' && row.engine.version===PRODUCT_PROOF_RUNTIME.web) ||
     nativeResults.some(row=>row?.selected && !targets.some(target=>target.id===row.targetId && target.platform===row.platform))) reasons.push('native qualified target readback differs')
  for(const id of expected.requiredNativeTests) {
    const rows=nativeResults.filter(row=>row?.testId===id && row.selected)
    if(rows.length!==1 || !successfulResult(rows[0])) reasons.push('required native entry point missing, malformed, skipped or flaky')
  }
  // Separate continuity/control reports are selected by trusted hashes, never
  // inferred from a coverage prefix or accepted from an outcome label alone.
  async function execution(requirement,outcome) {
    if(!reference(requirement?.report) || typeof requirement.testId!=='string' || !validOracle(requirement.oracle)) return null
    const report=await json(requirement.report)
    const oracle=report?.oracle
    if(report?.schema!=='browser-execution.v1' || report.runner!=='node:test' || report.testId!==requirement.testId ||
       report.targetId!=='chromium' || report.platform!=='web' || report.status!==outcome || !Array.isArray(report.attempts) || report.attempts.length!==1 ||
       !validAttempt(report.attempts[0],outcome) || !oracle || oracle.id!==requirement.oracle.id ||
       !isDeepStrictEqual(oracle.expected,requirement.oracle.expected) ||
       (outcome==='passed' ? oracle.violation!==null || !isDeepStrictEqual(oracle.observed,oracle.expected) :
         typeof requirement.oracle.violation!=='string' || !requirement.oracle.violation || oracle.violation!==requirement.oracle.violation || isDeepStrictEqual(oracle.observed,oracle.expected))) return null
    return report
  }
  const coverage=await json(packet.coverage),executions=new Map()
  if(!Array.isArray(coverage?.rows) || !ids(coverage.rows.map(row=>row?.id))) reasons.push('invalid coverage rows')
  else {
    for(const id of expected.requiredCoverage) {
      const row=coverage.rows.find(row=>row.id===id),required=expected.coverageEvidence?.[id]
      if(row?.status!=='passed' || row.attempts!==1) reasons.push(`required coverage incomplete or flaky: ${id}`)
      if(required?.kind==='native') {
        if(!names(required.testIds) || !required.testIds.length || !isDeepStrictEqual(row?.testIds,required.testIds) ||
           required.testIds.some(testId=>!expected.requiredNativeTests.includes(testId) || !successfulResult(nativeResults.find(result=>result.testId===testId)))) reasons.push(`missing native coverage execution: ${id}`)
      } else if(required?.kind==='continuity' && isDeepStrictEqual(row?.report,required.report)) {
        const report=await execution(required,'passed')
        if(report) executions.set(id,{report,ref:required.report});else reasons.push(`missing continuity execution: ${id}`)
      } else reasons.push(`missing coverage execution: ${id}`)
    }
    if(coverage.rows.length!==expected.requiredCoverage.length || coverage.rows.some(row=>row.status!=='passed' || row.attempts!==1)) reasons.push('unrequired, failed, skipped or unknown coverage retained')
    for(const [role,outcome] of [['broken','failed'],['repaired','passed']]) {
      const required=expected.qualification?.[role]
      if(!isDeepStrictEqual(coverage.qualification?.[role]?.report,required?.report) || !await execution(required,outcome)) reasons.push('broken/repaired deciding execution missing')
    }
    if(expected.qualification?.broken?.report?.digest===expected.qualification?.repaired?.report?.digest) reasons.push('qualification reuses execution')
  }
  const captures=new Set()
  if(!Array.isArray(packet.persistence) || !ids(packet.persistence.map(row=>row?.id))) reasons.push('invalid persistence rows')
  else for(const id of expected.requiredPersistence) {
    const row=packet.persistence.find(row=>row.id===id),intent=expected.persistenceIntent?.[id]
    if(!row || !intent?.subject || !Object.hasOwn(intent,'value') || !['storage','key','operation'].every(key=>typeof intent.subject[key]==='string' && intent.subject[key])) {reasons.push(`missing persistence intent: ${id}`);continue}
    const written=await json(row.written),reread=await json(row.readback)
    for(const ref of [row.written,row.readback]) {
      if(captures.has(ref?.ref) || captures.has(ref?.digest)) reasons.push(`reused persistence capture: ${id}`)
      captures.add(ref?.ref);captures.add(ref?.digest)
    }
    if(!written || !reread || written.id!==id || reread.id!==id || !isDeepStrictEqual(written.subject,intent.subject) || !isDeepStrictEqual(reread.subject,intent.subject) ||
       written.phase!=='write' || reread.phase!=='reload' || !isDeepStrictEqual(written.value,intent.value) || !isDeepStrictEqual(reread.value,intent.value)) reasons.push(`independent reload differs from intended operation: ${id}`)
  }
  if(!Array.isArray(packet.recordings) || !ids(packet.recordings.map(row=>row?.id))) reasons.push('invalid recording rows')
  else for(const required of expected.requiredRecordings) {
    const row=packet.recordings.find(row=>row.id===required.id)
    if(!row || row.operation!==required.operation || !isDeepStrictEqual(row.provenance,required.provenance) || typeof input.inspectRecording!=='function') {reasons.push(`missing authenticated recording: ${required.id}`);continue}
    const provenance=await json(required.provenance),selected=executions.get(provenance?.testId)
    // This recording format is emitted by the continuity runner. Its exact
    // successful attempt and bytes are authenticated by the expectation store.
    if(provenance?.schema!=='browser-recording.v1' || provenance.id!==required.id || !selected ||
       !isDeepStrictEqual(provenance.execution,selected.ref) || provenance.attemptId!==selected.report.attempts[0].id ||
       provenance.targetId!=='chromium' || provenance.platform!=='web' || !['pageId','contextId'].every(key=>typeof provenance[key]==='string' && provenance[key]) ||
       !Number.isFinite(provenance.videoStartTime) || !Number.isFinite(provenance.checkpointTime) || provenance.checkpointTime<=provenance.videoStartTime ||
       !['video','trace','checkpoint'].every(key=>isDeepStrictEqual(row[key],provenance[key]))) {reasons.push(`recording provenance differs: ${required.id}`);continue}
    const video=await bytes(row.video),trace=await bytes(row.trace),checkpoint=await bytes(row.checkpoint)
    if(!video || !trace || !checkpoint) continue
    const controller=new AbortController()
    let timer
    try {
      const remaining=deadline-Date.now()
      if(remaining<=0) throw Error('inspection deadline')
      const result=await Promise.race([
        Promise.resolve().then(()=>input.inspectRecording({video,trace,checkpoint,operation:required.operation,provenance,expected:binding,deadline,signal:controller.signal})),
        new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('inspection deadline'))},remaining)})
      ])
      if(Date.now()>=deadline || result?.decoded!==true || result.operationPresent!==true) reasons.push(`recording does not prove operation: ${required.id}`)
    } catch {reasons.push(`recording inspection failed: ${required.id}`)}
    finally {clearTimeout(timer);controller.abort()}
  }
  if(Date.now()>=deadline) reasons.push('product proof deadline exceeded')
  return finish()
}

// Explicit measurements from an exact-head first review, collected by the
// orchestrator. Unknown values stay null until this observation exists.
export function productProofReviewMetrics({repo,sourceCommit,reviewedSha,commentUrl,firstReviewUiFindings,reproductionMinutes}={}) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo??'') || !/^[0-9a-f]{40}$/.test(sourceCommit??'') || reviewedSha!==sourceCommit ||
      typeof commentUrl!=='string' || !new RegExp(`^https://github\\.com/${repo.replaceAll('.', '\\.')}/pull/[0-9]+#issuecomment-[0-9]+$`).test(commentUrl) ||
      !Number.isSafeInteger(firstReviewUiFindings) || firstReviewUiFindings<0 || !Number.isFinite(reproductionMinutes) || reproductionMinutes<0)
    throw Error('invalid exact-head review measurement')
  return {schema:'browser-proof-review-metrics.v1',repo,sourceCommit,commentUrl,firstReviewUiFindings,reproductionMinutes}
}
