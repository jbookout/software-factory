import fs from 'node:fs/promises'
import {constants} from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {readJson,writeJson} from './pr-delivery-state.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (root,...args) => execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:4*1024*1024}).trim()
const receiptName = '.factory-orch.json'
const runtimePaths = ['src','bin','deploy/orch','schemas','package.json','package-lock.json']
const within = (root,file) => file === root || file.startsWith(root+path.sep)
async function physicalPath(file) {
 file=path.resolve(file)
 try {return await fs.realpath(file)}
 catch(error){
   if(error.code!=='ENOENT')throw error
   const parent=path.dirname(file)
   if(parent===file)throw error
   return path.join(await physicalPath(parent),path.basename(file))
 }
}
function requireSeparation(sourceRoot,installedDir,configPath,stateDir) {
 const overlaps=(a,b)=>within(a,b)||within(b,a)
 if(overlaps(sourceRoot,installedDir)||overlaps(sourceRoot,stateDir)||overlaps(installedDir,stateDir)||within(installedDir,configPath)||within(sourceRoot,configPath))
   throw new Error('installation, configuration and private state must be separate from executable source')
}
export async function installOrchestration(sourceRoot, installedDir, configPath) {
 sourceRoot=await fs.realpath(sourceRoot); installedDir=await physicalPath(installedDir); configPath=await fs.realpath(configPath)
 const config=await readJson(configPath), stateDir=await physicalPath(path.resolve(path.dirname(configPath),config.stateDir))
 requireSeparation(sourceRoot,installedDir,configPath,stateDir)
 if(git(sourceRoot,'status','--porcelain','--untracked-files=all','--',...runtimePaths)) throw new Error('deliver clean committed factory source before installation')
 const sourceRevision=git(sourceRoot,'rev-parse','HEAD')
 const names=git(sourceRoot,'ls-files','-z',...runtimePaths).split('\0').filter(Boolean)
 if(!names.length || names.length>512) throw new Error('factory runtime inventory exceeds bound')
 const sources=[]
 for(const name of names) sources.push({path:name,sha256:hash(await fs.readFile(path.join(sourceRoot,name)))})
 const wrappers=sources.filter(s=>s.path.startsWith('deploy/orch/')&&s.path.endsWith('.sh'))
 if(!wrappers.length || wrappers.length>32) throw new Error('installed executable inventory exceeds bound')
 await fs.mkdir(installedDir,{recursive:true,mode:0o700})
 // Retain overwritten development scripts for rollback; never discard state.
 const backup=path.join(installedDir,`source-backup-${sourceRevision}`)
 for(const wrapper of wrappers){
   const destination=path.join(installedDir,path.basename(wrapper.path))
   try {await fs.access(destination);await fs.mkdir(backup,{recursive:true,mode:0o700});await fs.copyFile(destination,path.join(backup,path.basename(wrapper.path)),constants.COPYFILE_EXCL)}
   catch(error){if(!['ENOENT','EEXIST'].includes(error.code))throw error}
   await fs.copyFile(path.join(sourceRoot,wrapper.path),destination);await fs.chmod(destination,0o755)
 }
 const receipt={schema:'factory-orch-installation/v1',sourceRoot,sourceRevision,entrypoint:'bin/pr-delivery.mjs',configPath,stateDir,
   sources,executables:wrappers.map(w=>({path:path.basename(w.path),sha256:w.sha256})),installedAt:new Date().toISOString()}
 await writeJson(path.join(installedDir,receiptName),receipt)
 return receipt
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
 const executables=receipt.sources.filter(s=>s.path.startsWith('deploy/orch/')&&s.path.endsWith('.sh')).map(s=>({path:path.basename(s.path),sha256:s.sha256}))
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
