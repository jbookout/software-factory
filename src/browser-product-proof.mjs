// Exact-candidate intake. The caller supplies trusted expected identity and a
// bounded artifact store, never an expectation copied out of the candidate packet.
import { isDeepStrictEqual } from 'node:util'
import { createBoundReader } from './evidence.mjs'

export const PRODUCT_PROOF_RUNTIME = Object.freeze({e2e:'0.16.0',web:'0.11.2',playwright:'1.63.0',browser:'chromium'})
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const ids = value => Array.isArray(value) && Array.from(value).every(id => typeof id==='string' && /^[a-z0-9-]+$/.test(id)) && new Set(value).size===value.length
const identityKeys = ['repo','sourceCommit','buildDigest','buildConfigDigest','fixtureDigest','runtime','runId','attempt']
const safeLink = (value, repo) => typeof value === 'string' && new RegExp(`^https://github\\.com/${repo.replaceAll('.', '\\.')}\\/actions/runs/[0-9]+(?:/artifacts/[0-9]+)?$`).test(value)

export async function evaluateProductProofPacket(input) {
  const reasons=[]
  let packet, expected
  try { ({packet,expected}=structuredClone({packet:input.packet,expected:input.expected})) } catch { return {gate:'fail',reasons:['malformed product proof input']} }
  const finish = () => ({gate:reasons.length ? 'fail' : 'pass',reasons,sourceCommit:typeof expected?.sourceCommit==='string' && /^[0-9a-f]{40}$/.test(expected.sourceCommit) ? expected.sourceCommit : null})
  const binding=packet?.binding
  if (!packet?.metrics || packet.metrics.firstReviewUiFindings!==null &&
      (!Number.isSafeInteger(packet.metrics.firstReviewUiFindings) || packet.metrics.firstReviewUiFindings<0) ||
      !packet?.metrics || packet.metrics.reproductionMinutes!==null &&
      (!Number.isFinite(packet.metrics.reproductionMinutes) || packet.metrics.reproductionMinutes<0)) reasons.push('invalid review metrics')
  if (packet?.schema!=='browser-product-proof.v1' || !binding ||
      typeof expected?.repo!=='string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(expected.repo) ||
      !/^[0-9a-f]{40}$/.test(expected?.sourceCommit??'') ||
      !['buildDigest','buildConfigDigest','fixtureDigest'].every(key=>digest(expected[key])) ||
      !ids(expected?.requiredCoverage) || !expected.requiredCoverage.length ||
      !Array.isArray(expected?.requiredNativeTests) || !expected.requiredNativeTests.length ||
      !Array.from(expected.requiredNativeTests).every(id=>typeof id==='string' && id.length>0) || new Set(expected.requiredNativeTests).size!==expected.requiredNativeTests.length ||
      !ids(expected?.requiredPersistence) || !Array.isArray(expected?.requiredRecordings) ||
      !ids(expected.requiredRecordings.map(row=>row?.id)) ||
      expected.requiredRecordings.some(row=>row?.operation!=='save-reload')) {
    reasons.push('malformed packet or required manifest'); return finish()
  }
  for (const key of identityKeys) if (!isDeepStrictEqual(binding[key],expected[key])) reasons.push(`candidate identity mismatch: ${key}`)
  if (!Object.entries(PRODUCT_PROOF_RUNTIME).every(([key,value])=>binding.runtime?.[key]===value) ||
      !/^v?\d+\.\d+\.\d+$/.test(binding.runtime?.node??'')) reasons.push('unqualified runtime')
  if (typeof binding.runId!=='string' || !/^[a-zA-Z0-9-]+$/.test(binding.runId) ||
      !Number.isSafeInteger(binding.attempt) || binding.attempt<1) reasons.push('invalid run identity')
  if (!packet.links || !['run','artifacts'].every(key=>safeLink(packet.links[key],expected.repo)) ||
      packet.links.run.includes('/artifacts/') || ![packet.links.run,packet.links.run+'/artifacts/'+packet.links.artifacts.split('/').at(-1)].includes(packet.links.artifacts)) reasons.push('unsafe or missing artifact links')
  if (typeof input.readArtifact!=='function') {reasons.push('missing artifact reader');return finish()}
  let read
  try {read=createBoundReader({readArtifact:input.readArtifact,limits:input.limits})}
  catch {reasons.push('invalid artifact reader limits');return finish()}
  async function bytes(ref) {
    const result=await read(ref)
    if (!result.bytes) {reasons.push('missing, empty, unreadable or altered artifact');return null}
    return result.bytes
  }
  async function json(ref) {
    const data=await bytes(ref); if (!data) return null
    try {
      const result=JSON.parse(data)
      if (!isDeepStrictEqual(result.binding,binding)) {reasons.push('artifact run/build binding mismatch');return null}
      return result
    } catch {reasons.push('malformed artifact JSON');return null}
  }
  if (packet.buildArchive?.digest!==binding.buildDigest) reasons.push('archive differs from candidate build')
  await bytes(packet.buildArchive)
  const build=await json(packet.build)
  if (!build || !Array.isArray(build.manifestFiles) || !build.manifestFiles.length ||
      !isDeepStrictEqual(build.manifestFiles,build.servedFiles)) reasons.push('served build identity readback differs')
  const nativeBytes=await bytes(packet.nativeReport)
  let native
  try {native=JSON.parse(nativeBytes)} catch {reasons.push('missing native e2e report')}
  if (native?.schemaVersion!=='report-1' || native.run?.runner?.version!==PRODUCT_PROOF_RUNTIME.e2e ||
      native.run?.id!==binding.runId || native.run?.vcs?.commit!==binding.sourceCommit || native.run.vcs.dirty!==false ||
      native.run?.exitCode!==0 || native.run?.status!=='passed' || !Array.isArray(native.run?.results) ||
      !native.run.results.length || native.run.results.some(row=>!row || typeof row.selected!=='boolean' || (row.selected && (row.status!=='passed' || row.attempts?.length!==1))))
    reasons.push('native e2e result is empty, stale, dirty or not successful')
  const nativeResults=Array.isArray(native?.run?.results) ? native.run.results : []
  const nativeTargets=Array.isArray(native?.run?.targets) ? native.run.targets : []
  if (native?.run?.environment?.runtime!==`node v${binding.runtime?.node}` ||
      !nativeTargets.some(row=>row?.id==='chromium' && row.engine?.name==='web' && row.engine.version===PRODUCT_PROOF_RUNTIME.web)) reasons.push('native runtime readback differs')
  for(const id of expected.requiredNativeTests) {
    const rows=nativeResults.filter(row=>row?.testId===id && row.selected)
    if(rows.length!==1 || rows[0].status!=='passed' || rows[0].attempts?.length!==1) reasons.push('required native entry point missing, skipped or flaky')
  }
  const coverage=await json(packet.coverage)
  if (!Array.isArray(coverage?.rows) || !ids(coverage.rows.map(row=>row?.id))) reasons.push('invalid coverage rows')
  else {
    if (coverage.qualification?.broken!=='failed' || coverage.qualification?.repaired!=='passed') reasons.push('broken/repaired qualification missing')
    for (const id of expected.requiredCoverage) {
      if (id.startsWith('w')) {
        const matches=nativeResults.filter(row=>row?.selected && typeof row.file==='string' && row.file.endsWith(`${id}.e2e.ts`))
        if (!matches.length || matches.some(row=>row.status!=='passed')) reasons.push(`missing native journey: ${id}`)
      }
      const row=coverage.rows.find(row=>row.id===id)
      if (row?.status!=='passed' || row.attempts!==1) reasons.push(`required coverage incomplete or flaky: ${id}`)
    }
    if (coverage.rows.some(row=>row.status!=='passed' || row.attempts!==1)) reasons.push('failed, skipped, blocked or unknown coverage retained')
  }
  if (!Array.isArray(packet.persistence) || !ids(packet.persistence.map(row=>row?.id))) reasons.push('invalid persistence rows')
  else for (const id of expected.requiredPersistence) {
    const row=packet.persistence.find(row=>row.id===id)
    if (!row) {reasons.push(`missing persistence: ${id}`);continue}
    const written=await json(row.written), reread=await json(row.readback)
    if (!written || !reread || written.phase!=='write' || reread.phase!=='reload' || written.value===undefined ||
        !isDeepStrictEqual(written.value,reread.value) || row.written.ref===row.readback.ref || row.written.digest===row.readback.digest)
      reasons.push(`independent reload differs or is missing: ${id}`)
  }
  if (!Array.isArray(packet.recordings) || !ids(packet.recordings.map(row=>row?.id))) reasons.push('invalid recording rows')
  else for (const required of expected.requiredRecordings) {
    const row=packet.recordings.find(row=>row.id===required.id)
    if (!row || row.operation!==required.operation || typeof input.inspectRecording!=='function') {reasons.push(`missing recording inspection: ${required.id}`);continue}
    const video=await bytes(row.video), trace=await bytes(row.trace), checkpoint=await bytes(row.checkpoint)
    if (!video || !trace || !checkpoint) continue
    try {
      const result=await input.inspectRecording({video,trace,checkpoint,operation:required.operation})
      if (result?.decoded!==true || result.operationPresent!==true) reasons.push(`recording does not prove operation: ${required.id}`)
    } catch { reasons.push(`recording inspection failed: ${required.id}`) }
  }
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
