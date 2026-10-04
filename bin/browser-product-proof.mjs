#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { evaluateProductProofPacket, productProofReviewMetrics } from '../src/design-verify.mjs'
import { createArtifactReader } from '../src/evidence.mjs'
import { inspectBrowserRecording } from '../src/browser-recording-inspector.mjs'
// Expected identity is orchestrator-owned; never derive it from packet binding.
try {
  const args=process.argv.slice(2)
  if (args[0]==='--review-metrics') {
    const [_,repo,sourceCommit,reviewedSha,commentUrl,count,minutes]=args
    console.log(JSON.stringify(productProofReviewMetrics({repo,sourceCommit,reviewedSha,commentUrl,firstReviewUiFindings:Number(count),reproductionMinutes:Number(minutes)})))
  } else {
    const [store,packetFile,expectedFile]=args
    if(!store || !packetFile || !expectedFile) throw Error('arguments required')
    const packet=JSON.parse(await readFile(packetFile,'utf8'))
    const expected=JSON.parse(await readFile(expectedFile,'utf8'))
    const result=await evaluateProductProofPacket({packet,expected,readArtifact:createArtifactReader(store,{maxBytes:64*1024*1024,timeoutMs:30_000}),limits:{maxBytes:64*1024*1024,timeoutMs:30_000},inspectRecording:inspectBrowserRecording})
    console.log(JSON.stringify(result)); if(result.gate!=='pass') process.exitCode=1
  }
} catch {console.log(JSON.stringify({gate:'fail',reasons:['product proof intake could not read its inputs']}));process.exitCode=1}
