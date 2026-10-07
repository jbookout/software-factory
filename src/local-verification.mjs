import fs from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { runProcess, validateProcessRequest } from './process-runner.mjs'
import { monotonicNow } from './deadline.mjs'
import { observeCheckResources } from './check-resources.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const missing = error => { if (error.code === 'ENOENT') return null; throw error }

export async function verificationSource(cwd) {
  const git = (args, directory = cwd) => execFileSync('git', args, { cwd:directory, encoding:'utf8', maxBuffer:20_000_000 })
  const root = git(['rev-parse','--show-toplevel']).trim()
  for (const entry of git(['ls-files','--stage','-z'], root).split('\0').filter(Boolean)) {
    if (entry.startsWith('120000 ')) throw new Error('unsupported source checkout: symlink')
    if (entry.startsWith('160000 ')) throw new Error('unsupported source checkout: gitlink')
  }
  const files = git(['ls-files','-co','--exclude-standard','-z'], root).split('\0').filter(Boolean)
  const hash = createHash('sha256')
  for (const file of [...new Set(files)].sort()) {
    const location = path.join(root,file)
    const stat = await fs.lstat(location).catch(missing)
    if (stat && !stat.isFile()) throw new Error('unsupported source checkout: symlink or non-file')
    hash.update(JSON.stringify([file,stat?.mode ?? null,stat ? digest(await fs.readFile(location)) : 'deleted']))
  }
  return {repository:git(['rev-parse','--path-format=absolute','--git-common-dir']).trim(), cwd:path.resolve(cwd),
    head:git(['rev-parse','HEAD']).trim(), tree:hash.digest('hex')}
}
async function verifySource(binding) {
  const expected = Object.fromEntries(['repository','cwd','head','tree'].map(k=>[k,binding[k]]))
  if (JSON.stringify(await verificationSource(binding.cwd)) !== JSON.stringify(expected))
    throw new Error('verification source binding changed')
}
export async function allocateVerification({cwd,producer,argv,root=os.tmpdir()}) {
  if (!producer) throw new Error('verification producer required')
  validateProcessRequest(argv)
  const binding = {producer,attempt:randomUUID(),...await verificationSource(cwd),argv:[...argv]}
  await fs.mkdir(root,{recursive:true,mode:0o700})
  const directory = await fs.mkdtemp(path.join(root,'factory-attempt-'))
  return {directory,binding,log:path.join(directory,'output.log'),receipt:path.join(directory,'verification.json')}
}

const shells = new Set(['sh','bash','dash','zsh','ksh','fish','csh','tcsh','powershell','pwsh','cmd','cmd.exe'])
async function rejectShell(argv, cwd, env) {
  const name = path.basename(argv[0])
  if (shells.has(name) || /\.(sh|bash|zsh|ps1|bat|cmd)$/.test(name) ||
      ['env','nohup','timeout','nice'].includes(name))
    throw new Error('shell commands and launch wrappers are unsupported for owned verification outputs')
  const candidates = argv[0].includes(path.sep) ? [path.resolve(cwd,argv[0])] :
    (env.PATH ?? '').split(path.delimiter).map(dir=>path.resolve(cwd,dir,argv[0]))
  for (const candidate of candidates) {
    let handle
    try {
      if (shells.has(path.basename(await fs.realpath(candidate))))
        throw new Error('shell executables are unsupported for owned verification outputs')
      handle = await fs.open(candidate,'r')
      const bytes = Buffer.alloc(512)
      const {bytesRead} = await handle.read(bytes,0,bytes.length,0)
      const firstLine = bytes.subarray(0,bytesRead).toString().split('\n')[0]
      if (firstLine.startsWith('#!') && firstLine.slice(2).trim().split(/\s+/).some(word=>shells.has(path.basename(word))))
        throw new Error('shell scripts are unsupported for owned verification outputs')
      return
    } catch (error) {
      if (!['ENOENT','ENOTDIR','EACCES'].includes(error.code)) throw error
    } finally { await handle?.close() }
  }
}

export async function validateLaunchOutput(argv,directory,cwd,env=process.env) {
  validateProcessRequest(argv)
  if (!cwd) throw new Error('child working directory required for output validation')
  await rejectShell(argv,cwd,env)
  const owned = await fs.realpath(directory)
  for (const [index,arg] of argv.entries()) {
    const flag=['--output-last-message','--output'].find(flag=>arg===flag || arg.startsWith(flag+'='))
    if (!flag) continue
    const value=arg===flag?argv[index+1]:arg.slice(flag.length+1)
    if (!value || value.startsWith('--') || ['.','..'].includes(path.basename(value)))
      throw new Error('output must belong to owned attempt directory')
    // Resolve each parent component physically before traversing "..".
    let parent = path.isAbsolute(value) ? path.parse(value).root : await fs.realpath(cwd)
    for (const part of path.dirname(value).split(path.sep).filter(Boolean)) {
      parent = await fs.realpath(path.join(parent,part)).catch(error=>{
        if (['ENOENT','ENOTDIR'].includes(error.code)) throw new Error('output must belong to owned attempt directory')
        throw error
      })
    }
    if (parent !== owned) throw new Error('output must belong to owned attempt directory')
    const stat = await fs.lstat(path.join(parent,path.basename(value))).catch(missing)
    if (stat?.isSymbolicLink()) throw new Error('output symlink is unsupported')
    if (stat && !stat.isFile()) throw new Error('output must be an owned attempt file')
  }
}

export async function readVerification(file,expected,receiptDigest) {
  const bytes = await fs.readFile(file)
  if (!receiptDigest || digest(bytes) !== receiptDigest) throw new Error('verification producer receipt digest mismatch')
  const receipt=JSON.parse(bytes)
  if (receipt.schema!=='factory-verification/v1' || JSON.stringify(receipt.binding)!==JSON.stringify(expected))
    throw new Error('verification receipt binding mismatch')
  if (path.resolve(receipt.log)!==path.join(path.dirname(path.resolve(file)),'output.log') ||
      !(await fs.lstat(receipt.log)).isFile() || digest(await fs.readFile(receipt.log))!==receipt.logDigest)
    throw new Error('verification log digest mismatch')
  await verifySource(expected)
  if (!Number.isInteger(receipt.code)) throw new Error('verification exit status missing')
  return {...expected,code:receipt.code,log:receipt.log,receiptDigest,
    ...(receipt.metrics ? { metrics: receipt.metrics } : {})}
}
export async function runVerification({cwd,producer,argv,attempt,timeoutMs=3600_000,admission,signal}) {
  attempt ??= await allocateVerification({cwd,producer,argv})
  const {binding,log,receipt,directory}=attempt
  if (binding.cwd!==path.resolve(cwd) || binding.producer!==producer || JSON.stringify(binding.argv)!==JSON.stringify(argv))
    throw new Error('verification attempt binding mismatch')
  await validateLaunchOutput(argv,directory,cwd)
  await verifySource(binding)
  const handle=await fs.open(log,'wx',0o600)
  await handle.close()
  const began=monotonicNow()
  let stopResources, resources, result
  try {
    result=await runProcess(argv,{cwd,env:{...process.env,...admission?.env,TMPDIR:directory,FACTORY_ATTEMPT_DIR:directory},
      timeoutMs,signal,captureOutput:false,onOutput:chunk=>appendFileSync(log,chunk),
      onSpawn:async(job,bindingSignal)=>{
        if(admission)stopResources=observeCheckResources(job.pid)
        return admission?.bindJob(job,bindingSignal)
      }})
  } finally { resources=await stopResources?.() }
  const metrics=admission ? {...admission.metrics,elapsedMs:monotonicNow()-began,resources} : undefined
  const bytes=JSON.stringify({schema:'factory-verification/v1',binding,code:result.code,
    log,logDigest:digest(await fs.readFile(log)),...(metrics ? { metrics } : {})})
  await fs.writeFile(receipt,bytes,{flag:'wx',mode:0o600})
  const receiptDigest=digest(bytes)
  await readVerification(receipt,binding,receiptDigest)
  return {...attempt,receiptDigest}
}
