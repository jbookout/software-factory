import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {readJson,writeJson} from './pr-delivery-state.mjs'
import {hash,git,runtimePaths,physicalPath,requireSeparation,isExecutable,executableBytes,deliveryStateDir} from '../deploy/orch/factory-verify.mjs'
export {checkOrchestration} from '../deploy/orch/factory-verify.mjs'
const receiptName='.factory-orch.json'
export async function installOrchestration(sourceRoot, installedDir, configPath) {
 sourceRoot=await fs.realpath(sourceRoot); installedDir=await physicalPath(installedDir); configPath=await fs.realpath(configPath)
 const config=await readJson(configPath), stateDir=await physicalPath(deliveryStateDir(configPath,config.stateDir))
 requireSeparation(sourceRoot,installedDir,configPath,stateDir)
 if(git(sourceRoot,'status','--porcelain','--untracked-files=all','--',...runtimePaths)) throw new Error('deliver clean committed factory source before installation')
 const sourceRevision=git(sourceRoot,'rev-parse','HEAD')
 const names=git(sourceRoot,'ls-files','-z',...runtimePaths).split('\0').filter(Boolean)
 if(!names.length || names.length>512) throw new Error('factory runtime inventory exceeds bound')
 const sources=[]
 for(const name of names) sources.push({path:name,sha256:hash(await fs.readFile(path.join(sourceRoot,name)))})
 const wrappers=sources.filter(s=>isExecutable(s.path))
 if(!wrappers.length || wrappers.length>32) throw new Error('installed executable inventory exceeds bound')
 await fs.mkdir(installedDir,{recursive:true,mode:0o700})
 // Keep the complete prior installation, including source at its original revision.
 const previous=await readJson(path.join(installedDir,receiptName),null)
 if(previous) {
   const backup=path.join(installedDir,`source-backup-${previous.sourceRevision}`)
   try {
     await fs.access(backup)
     const retained=await readJson(path.join(backup,receiptName),null)
     if(!retained || retained.sourceRevision!==previous.sourceRevision)throw new Error('incomplete rollback backup; reconcile before reinstall')
   } catch(error) {
     if(error.code!=='ENOENT')throw error
     const snapshot=path.join(path.dirname(installedDir),`.factory-orch-source-${previous.sourceRevision}`)
     try {await fs.access(snapshot)} catch(error) {
       if(error.code!=='ENOENT')throw error
       git(previous.sourceRoot,'clone','--quiet','--no-hardlinks',previous.sourceRoot,snapshot)
       git(snapshot,'checkout','--quiet','--detach',previous.sourceRevision)
       const modules=await fs.realpath(path.join(previous.sourceRoot,'node_modules')).catch(()=>null)
       if(modules)await fs.cp(modules,path.join(snapshot,'node_modules'),{recursive:true,dereference:true})
     }
     const retained={...previous,sourceRoot:await fs.realpath(snapshot)}
     // Validate snapshot bytes against A, even if the supplied source now contains B.
     for(const source of retained.sources)if(hash(await fs.readFile(path.join(snapshot,source.path)))!==source.sha256)
       throw new Error('rollback source hash mismatch')
     const staging=`${backup}.${randomUUID()}.tmp`
     await fs.mkdir(staging,{recursive:true,mode:0o700})
     for(const executable of previous.executables) {
       const bytes=await fs.readFile(path.join(installedDir,executable.path))
       if(hash(bytes)!==executable.sha256)throw new Error('rollback executable hash mismatch')
       await fs.writeFile(path.join(staging,executable.path),bytes,{mode:0o755,flag:'wx'})
     }
     await writeJson(path.join(staging,receiptName),retained)
     await fs.rename(staging,backup)
   }
 }
 const executables=[]
 for(const wrapper of wrappers){
   const bytes=executableBytes(wrapper.path,await fs.readFile(path.join(sourceRoot,wrapper.path)))
   const name=path.basename(wrapper.path)
   await fs.writeFile(path.join(installedDir,name),bytes,{mode:0o755});await fs.chmod(path.join(installedDir,name),0o755)
   executables.push({path:name,sha256:hash(bytes)})
 }
 const receipt={schema:'factory-orch-installation/v1',sourceRoot,sourceRevision,entrypoint:'bin/pr-delivery.mjs',configPath,stateDir,
   sources,executables,installedAt:new Date().toISOString()}
 await writeJson(path.join(installedDir,receiptName),receipt)
 return receipt
}
