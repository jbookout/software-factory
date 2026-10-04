#!/usr/bin/env node
import { productProofReviewMetrics } from '../src/design-verify.mjs'
import { evaluateProductProofFiles } from '../src/product-proof-policy.mjs'
// Expected identity is orchestrator-owned; never derive it from packet binding.
try {
  const args=process.argv.slice(2)
  if (args[0]==='--review-metrics') {
    const [_,repo,sourceCommit,reviewedSha,commentUrl,count,minutes]=args
    console.log(JSON.stringify(productProofReviewMetrics({repo,sourceCommit,reviewedSha,commentUrl,firstReviewUiFindings:Number(count),reproductionMinutes:Number(minutes)})))
  } else {
    const [store,packetFile,expectedFile]=args
    if(!store || !packetFile || !expectedFile) throw Error('arguments required')
    const result=await evaluateProductProofFiles({store,packetFile,expectedFile})
    console.log(JSON.stringify(result)); if(result.gate!=='pass') process.exitCode=1
  }
} catch {console.log(JSON.stringify({gate:'fail',reasons:['product proof intake could not read its inputs']}));process.exitCode=1}
