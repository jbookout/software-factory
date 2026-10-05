import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {installOrchestration,checkOrchestration} from '../src/orch-installation.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
const cli=path.join(root,'bin/orch-install.mjs')
const invoke=(...args)=>execFileSync(process.execPath,[cli,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']})
test('retro 3: installed entrypoints bind source, route to factory and detect drift',async t=>{
 const privateRoot=await fs.mkdtemp(path.join(os.tmpdir(),'factory-installed-'))
 t.after(()=>fs.rm(privateRoot,{recursive:true,force:true}))
 const source=path.join(privateRoot,'source'), installed=path.join(privateRoot,'installed'),stateDir=path.join(privateRoot,'state')
 execFileSync('git',['clone','--quiet','--no-hardlinks',root,source])
 // Deliver candidate files into a fixture commit before installing them.
 for(const name of ['src/orch-installation.mjs','bin/orch-install.mjs','deploy/orch/factory-verify.mjs','deploy/orch/factory-entry.sh','deploy/orch/test-browser.sh','deploy/orch/branch-wt.sh','deploy/orch/merge-enqueue.sh']){
   await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true})
   await fs.copyFile(path.join(root,name),path.join(source,name))
 }
 execFileSync('git',['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','add','src/orch-installation.mjs','bin/orch-install.mjs','deploy/orch/factory-verify.mjs','deploy/orch/factory-entry.sh','deploy/orch/test-browser.sh','deploy/orch/branch-wt.sh','deploy/orch/merge-enqueue.sh'])
 execFileSync('git',['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Delivered fixture'])
 const config=path.join(privateRoot,'config.json')
 await fs.writeFile(config,JSON.stringify({stateDir}))
 const receipt=JSON.parse(invoke('install',source,installed,config))
 assert.equal(receipt.sourceRevision,execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim())
 assert.equal(receipt.entrypoint,'bin/pr-delivery.mjs');assert.equal(receipt.stateDir,path.join(await fs.realpath(privateRoot),'state'))
 assert.equal(JSON.parse(invoke('check',installed)).status,'bound')
 for(const executable of receipt.executables.filter(e=>e.path.endsWith(".sh"))){
   // bound-source probe exercises each actual installed wrapper without model/network work.
   const out=execFileSync('sh',[path.join(installed,executable.path),'--factory-binding'],{encoding:'utf8'})
   const binding=JSON.parse(out);assert.equal(binding.sourceRevision,receipt.sourceRevision)
   assert.equal(binding.entrypoint,receipt.entrypoint)
 }
 await fs.appendFile(path.join(installed,'review-pr.sh'),'\n# drift\n')
 assert.throws(()=>invoke('check',installed),e=>/review-pr.sh.*reinstall/.test(e.stderr.toString()))
 assert.throws(()=>execFileSync('sh',[path.join(installed,'review-pr.sh'),'--factory-binding'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}))
})

for(const target of ['source','installed']) test(`retro 3: private state cannot alias ${target} through an existing ancestor`,async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'factory-alias-'))
 t.after(()=>fs.rm(base,{recursive:true,force:true}))
 const source=path.join(base,'source'),installed=path.join(base,'installed'),alias=path.join(base,'private')
 execFileSync('git',['clone','--quiet','--no-hardlinks',root,source])
 await fs.mkdir(installed)
 await fs.symlink(target==='source'?source:installed,alias,'dir')
 const config=path.join(base,'config.json')
 await fs.writeFile(config,JSON.stringify({stateDir:path.join(alias,'new-state')}))
 await assert.rejects(installOrchestration(source,installed,config),/separate/)
})
test('retro 3: readback detects private state symlink retargeting',async t=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'factory-alias-'))
 t.after(()=>fs.rm(base,{recursive:true,force:true}))
 const source=path.join(base,'source'),installed=path.join(base,'installed'),alias=path.join(base,'private'),state=path.join(base,'state')
 execFileSync('git',['clone','--quiet','--no-hardlinks',root,source])
 await fs.mkdir(state);await fs.symlink(state,alias,'dir')
 const config=path.join(base,'config.json')
 await fs.writeFile(config,JSON.stringify({stateDir:alias}))
 await installOrchestration(source,installed,config)
 await fs.rename(alias,path.join(base,'old-alias'));await fs.symlink(source,alias,'dir')
 await assert.rejects(checkOrchestration(installed),/separate|location changed/)
})

async function installedCandidate(t, suffix='installed') {
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'factory-binding-'))
 t.after(()=>fs.rm(base,{recursive:true,force:true}))
 const source=path.join(base,'source'),installed=path.join(base,suffix),config=path.join(base,'config.json')
 execFileSync('git',['clone','--quiet','--no-hardlinks',root,source])
 for(const dir of ['src','bin','deploy/orch']) await fs.cp(path.join(root,dir),path.join(source,dir),{recursive:true})
 const git=(...a)=>execFileSync('git',['-C',source,...a],{encoding:'utf8'}).trim()
 git('add','src','bin','deploy/orch');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Candidate')
 await fs.writeFile(config,JSON.stringify({stateDir:path.join(base,'state')}))
 const receipt=await installOrchestration(source,installed,config)
 const wrapper=()=>execFileSync('sh',[path.join(installed,'review-pr.sh'),'--factory-binding'],{env:{...process.env,FACTORY_ROOT:path.dirname(path.dirname(installed)),FACTORY_PR_CONFIG:config},encoding:'utf8',stdio:['ignore','pipe','pipe']})
 return {base,source,installed,config,git,receipt,wrapper}
}

test('blocking 2: receipt removal refuses even in a deploy/orch installation layout',async t=>{
 const f=await installedCandidate(t,'alternate/deploy/orch'),marker=path.join(f.base,'executed')
 await fs.rename(path.join(f.installed,'.factory-orch.json'),path.join(f.installed,'saved-receipt'))
 const bin=path.join(f.base,'alternate/bin');await fs.mkdir(bin,{recursive:true})
 await fs.writeFile(path.join(bin,'pr-delivery.mjs'),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed')`)
 assert.throws(f.wrapper,e=>e.status===9)
 assert.equal(await fs.access(marker).then(()=>true,()=>false),false)
})

for(const module of ['src/pr-delivery-state.mjs','bin/orch-install.mjs']) test(`blocking 3: source drift is refused before evaluating ${module}`,async t=>{
 const f=await installedCandidate(t),marker=path.join(f.base,'executed')
 await fs.appendFile(path.join(f.source,module),`\nimport fsSentinel from 'node:fs';fsSentinel.writeFileSync(${JSON.stringify(marker)},'executed');\n`)
 assert.throws(f.wrapper,e=>e.status===9)
 assert.equal(await fs.access(marker).then(()=>true,()=>false),false)
})

test('blocking 9: rollback retains wrappers, receipt and independently invocable source revision',async t=>{
 const f=await installedCandidate(t),old=f.receipt.sourceRevision
 await fs.appendFile(path.join(f.source,'deploy/orch/review-pr.sh'),'\n# revision B\n')
 f.git('add','deploy/orch/review-pr.sh');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Revision B')
 await installOrchestration(f.source,f.installed,f.config)
 const backups=(await fs.readdir(f.installed)).filter(n=>n.startsWith('source-backup-'))
 assert.equal(backups.length,1)
 const backup=path.join(f.installed,backups[0])
 const retained=JSON.parse(await fs.readFile(path.join(backup,'.factory-orch.json'),'utf8'))
 assert.equal(retained.sourceRevision,old)
 for(const name of ['.factory-orch.json',...retained.executables.map(e=>e.path)]) await fs.copyFile(path.join(backup,name),path.join(f.installed,name))
 assert.equal(JSON.parse(f.wrapper()).sourceRevision,old)
})
