import { dirname, relative, resolve } from 'node:path'
import { createArtifactReader } from './evidence.mjs'
import { evaluateProductProofPacket } from './browser-product-proof.mjs'
import { inspectBrowserRecording } from './browser-recording-inspector.mjs'

// One qualified policy for both delivery and CLI. Files outside the candidate
// store are allowed only for the independently owned expectation file. Each
// initial JSON read uses the same regular-file/confinement reader as artifacts.
const LIMITS=Object.freeze({maxBytes:64*1024*1024,timeoutMs:30_000})
const JSON_LIMIT=1024*1024
export async function evaluateProductProofFiles({store,packetFile,expectedFile,expectedRoot=dirname(resolve(expectedFile)),authority}) {
  const deadline=Date.now()+LIMITS.timeoutMs
  const refused=()=>({gate:'fail',reasons:['product proof input unavailable'],sourceCommit:null})
  try {
    const artifactReader=createArtifactReader(store,LIMITS)
    const expectedReader=createArtifactReader(expectedRoot,LIMITS)
    const initial=async(reader,ref)=>{
      const timeoutMs=deadline-Date.now()
      if(timeoutMs<=0) throw Error('input deadline')
      const bytes=await reader(ref,{maxBytes:JSON_LIMIT,timeoutMs})
      if(!bytes?.length) throw Error('initial input unavailable')
      return JSON.parse(bytes)
    }
    const expected=await initial(expectedReader,relative(resolve(expectedRoot),resolve(expectedFile)))
    const packet=await initial(artifactReader,relative(resolve(store),resolve(packetFile)))
    if(authority && (expected.repo!==authority.repo || expected.sourceCommit!==authority.head)) return refused()
    return await evaluateProductProofPacket({packet,expected,readArtifact:artifactReader,limits:LIMITS,deadline,inspectRecording:inspectBrowserRecording})
  } catch {return refused()}
}
