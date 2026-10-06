import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
const readJson = async (file,fallback) => {try{return JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}}
export const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export const git = (root,...args) => execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:4*1024*1024}).trim()
const receiptName = '.factory-orch.json'
export const runtimePaths = ['src','bin','deploy/orch','schemas','config/delivery-models.v1.json','config/review-tiers','package.json','package-lock.json']
const within = (root,file) => file === root || file.startsWith(root+path.sep)
export async function physicalPath(file) {
 file=path.resolve(file)
 try {return await fs.realpath(file)}
 catch(error){
   if(error.code!=='ENOENT')throw error
   const parent=path.dirname(file)
   if(parent===file)throw error
   return path.join(await physicalPath(parent),path.basename(file))
 }
}
export function requireSeparation(sourceRoot,installedDir,configPath,stateDir) {
 const overlaps=(a,b)=>within(a,b)||within(b,a)
 if(overlaps(sourceRoot,installedDir)||overlaps(sourceRoot,stateDir)||overlaps(installedDir,stateDir)||within(installedDir,configPath)||within(sourceRoot,configPath))
   throw new Error('installation, configuration and private state must be separate from executable source')
}

export const isExecutable = name => name.startsWith('deploy/orch/') && (name.endsWith('.sh') || name==='deploy/orch/factory-verify.mjs')
export function executableBytes(name,bytes) {
 if(name!=='deploy/orch/factory-entry.sh')return bytes
 // Only repository copies include replay. Installed entrypoints require their receipt in every layout.
 const text=bytes.toString('utf8'),start=text.indexOf('# Source adapters'),end=text.indexOf("echo 'missing installation receipt",start)
 if(start<0||end<0)throw new Error('invalid factory entrypoint template')
 return Buffer.from(text.slice(0,start)+text.slice(end))
}
export async function checkOrchestration(installedDir) {
 installedDir=await physicalPath(installedDir)
 const receipt=await readJson(path.join(installedDir,receiptName),null)
 if(receipt?.schema!=='factory-orch-installation/v1'||receipt.entrypoint!=='bin/pr-delivery.mjs'||
   !/^[0-9a-f]{40}$/.test(receipt.sourceRevision??'')||!receipt.sources?.length||receipt.sources.length>512||
   !receipt.executables?.length||receipt.executables.length>32) throw new Error('missing or invalid installation receipt; reinstall delivered source')
 if(git(receipt.sourceRoot,'rev-parse','HEAD')!==receipt.sourceRevision) throw new Error('factory source revision moved; reinstall delivered source')
 if(git(receipt.sourceRoot,'status','--porcelain','--untracked-files=all','--',...runtimePaths)) throw new Error('factory runtime source changed; reinstall delivered source')
 const inventory=git(receipt.sourceRoot,'ls-files','-z',...runtimePaths).split('\0').filter(Boolean)
 if(JSON.stringify(inventory)!==JSON.stringify(receipt.sources.map(s=>s.path))) throw new Error('factory runtime inventory changed; reinstall delivered source')
 const executables=await Promise.all(receipt.sources.filter(s=>isExecutable(s.path)).map(async s=>({path:path.basename(s.path),sha256:hash(executableBytes(s.path,await fs.readFile(path.join(receipt.sourceRoot,s.path))))})))
 if(JSON.stringify(executables)!==JSON.stringify(receipt.executables))throw new Error('installed executable inventory changed; reinstall delivered source')
 for(const [directory,files] of [[receipt.sourceRoot,receipt.sources],[installedDir,receipt.executables]]) for(const file of files){
   if(!file.path || path.isAbsolute(file.path)||file.path.split('/').includes('..'))throw new Error('invalid manifest path; reinstall delivered source')
   const actual=await fs.readFile(path.join(directory,file.path)).catch(()=>null)
   if(!actual || hash(actual)!==file.sha256)throw new Error(`${file.path} hash mismatch; reinstall delivered source before invoking orchestration`)
 }
 const config=await readJson(receipt.configPath)
 const sourceRoot=await fs.realpath(receipt.sourceRoot),configPath=await fs.realpath(receipt.configPath),stateDir=await physicalPath(path.resolve(path.dirname(configPath),config.stateDir))
 requireSeparation(sourceRoot,installedDir,configPath,stateDir)
 if(stateDir!==receipt.stateDir)throw new Error('private state location changed; reinstall with owning configuration')
 return {...receipt,status:'bound'}
}

export async function invokeOrchestration(directory,command,...inputs) {
 const binding=await checkOrchestration(directory)
 if(inputs[0]==='--factory-binding'||command==='--factory-binding')console.log(JSON.stringify(binding))
 else {
  const entrypoint=path.join(binding.sourceRoot,command==='browser-suite'?'bin/browser-suite.mjs':binding.entrypoint)
  process.argv=[process.execPath,entrypoint,binding.configPath,...(command==='browser-suite'?[]:[command]),...inputs]
  process.env.CARR_JEV_WORKER='off'
  await import(pathToFileURL(entrypoint).href)
 }
}
if(process.argv[1] && pathToFileURL(await fs.realpath(process.argv[1])).href===import.meta.url) {
 try {await invokeOrchestration(...process.argv.slice(2))}
 catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=9}
}
