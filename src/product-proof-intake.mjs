import {join} from 'node:path'
import {evaluateProductProofFiles} from './product-proof-policy.mjs'

// Configured roots supply independently owned expectations. No candidate field
// can select its expected build, required paths, controls or recording hashes.
export function createConfiguredProductProofIntake(config) {
  return async ({repo,head}) => {
    const policy=config.repos[repo]?.productProof
    if(!policy || !/^[0-9a-f]{40}$/.test(head) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return {gate:'fail',reasons:['missing product proof policy']}
    const key=repo.replace('/','--'),store=join(policy.artifactRoot,key,head)
    return evaluateProductProofFiles({store,packetFile:join(store,'packet.json'),expectedRoot:policy.expectedRoot,
      expectedFile:join(policy.expectedRoot,key,`${head}.json`),authority:{repo,head}})
  }
}
