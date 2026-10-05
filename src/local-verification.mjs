import fs from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { runProcess } from './process-runner.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export async function verificationSource(cwd) {
  const git = args => execFileSync('git', args, { cwd, encoding:'utf8', maxBuffer:20_000_000 }).trim()
  const files = git(['ls-files','-co','--exclude-standard','-z']).split('\0').filter(Boolean)
  const hash = createHash('sha256')
  for (const file of [...new Set(files)].sort()) {
    const stat = await fs.lstat(path.join(cwd,file)).catch(e => {if(e.code==='ENOENT')return null;throw e})
    let content='deleted'
    if (stat?.isSymbolicLink()) content=digest(await fs.readlink(path.join(cwd,file)))
    else if (stat?.isFile()) content=digest(await fs.readFile(path.join(cwd,file)))
    hash.update(JSON.stringify([file,stat?.mode ?? null,content]))
  }
  return {repository:git(['rev-parse','--path-format=absolute','--git-common-dir']), cwd:path.resolve(cwd),
    head:git(['rev-parse','HEAD']), tree:hash.digest('hex')}
}
export async function allocateVerification({cwd,producer,argv,root=os.tmpdir()}) {
  if (!producer || !Array.isArray(argv) || !argv.length) throw new Error('verification producer and command required')
  await fs.mkdir(root,{recursive:true})
  const directory = await fs.mkdtemp(path.join(root,'factory-attempt-'))
  const binding = {producer,attempt:randomUUID(),...await verificationSource(cwd),argv}
  return {directory,binding,log:path.join(directory,'output.log'),receipt:path.join(directory,'verification.json')}
}
export function validateLaunchOutput(argv,directory) {
  for (const [index,arg] of argv.entries()) {
    const flag=['--output-last-message','--output'].find(flag=>arg===flag || arg.startsWith(flag+'='))
    if(!flag)continue
    const value=arg===flag?argv[index+1]:arg.slice(flag.length+1)
    if(!value || path.dirname(path.resolve(value))!==path.resolve(directory))
      throw new Error('output must belong to owned attempt directory')
  }
}
export async function readVerification(file,expected) {
  const receipt=JSON.parse(await fs.readFile(file,'utf8'))
  if(receipt.schema!=='factory-verification/v1' || JSON.stringify(receipt.binding)!==JSON.stringify(expected))
    throw new Error('verification receipt binding mismatch')
  if(path.dirname(receipt.log)!==path.dirname(file) || digest(await fs.readFile(receipt.log))!==receipt.logDigest)
    throw new Error('verification log digest mismatch')
  if(JSON.stringify(await verificationSource(expected.cwd))!==JSON.stringify(Object.fromEntries(
    ['repository','cwd','head','tree'].map(k=>[k,expected[k]]))))throw new Error('verification source binding changed')
  if(!Number.isInteger(receipt.code))throw new Error('verification exit status missing')
  return {...expected,code:receipt.code,log:receipt.log}
}
export async function runVerification({cwd,producer,argv,attempt,timeoutMs=3600_000}) {
  attempt ??= await allocateVerification({cwd,producer,argv})
  const {binding,log,receipt,directory}=attempt
  if(binding.cwd!==path.resolve(cwd) || binding.producer!==producer || JSON.stringify(binding.argv)!==JSON.stringify(argv))
    throw new Error('verification attempt binding mismatch')
  validateLaunchOutput(argv,directory)
  const handle=await fs.open(log,'wx',0o600)
  await handle.close()
  const result=await runProcess(argv,{cwd,env:{...process.env,TMPDIR:directory,FACTORY_ATTEMPT_DIR:directory},
    timeoutMs,captureOutput:false,onOutput:chunk=>appendFileSync(log,chunk)})
  await fs.writeFile(receipt,JSON.stringify({schema:'factory-verification/v1',binding,code:result.code,
    log,logDigest:digest(await fs.readFile(log))}),{flag:'wx',mode:0o600})
  await readVerification(receipt,binding)
  return attempt
}
