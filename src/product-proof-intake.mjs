import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {evaluateProductProofPacket} from './browser-product-proof.mjs'
import {createArtifactReader} from './evidence.mjs'
import {inspectBrowserRecording} from './browser-recording-inspector.mjs'

// Only the configured orchestrator store supplies expectations. Candidate
// artifacts cannot pick their own expected build, coverage, workflow or attempt.
export function createConfiguredProductProofIntake(config) {
  return async ({repo,head}) => {
    const policy=config.repos[repo]?.productProof
    if(!policy || !/^[0-9a-f]{40}$/.test(head)) return {gate:'fail',reasons:['missing product proof policy']}
    const key=repo.replace('/','--')
    const store=join(policy.artifactRoot,key,head)
    try {
      const expected=JSON.parse(await readFile(join(policy.expectedRoot,key,`${head}.json`),'utf8'))
      const packet=JSON.parse(await readFile(join(store,'packet.json'),'utf8'))
      if(expected.repo!==repo || expected.sourceCommit!==head) return {gate:'fail',reasons:['orchestrator expectation mismatch']}
      return await evaluateProductProofPacket({packet,expected,readArtifact:createArtifactReader(store,{maxBytes:64*1024*1024,timeoutMs:30_000}),limits:{maxBytes:64*1024*1024,timeoutMs:30_000},inspectRecording:inspectBrowserRecording})
    } catch {return {gate:'fail',reasons:['product proof input unavailable']}}
  }
}
