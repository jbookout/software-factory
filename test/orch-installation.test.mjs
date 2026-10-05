import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
const cli=path.join(root,'bin/orch-install.mjs')
const invoke=(...args)=>execFileSync(process.execPath,[cli,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']})
test('retro 3: installed entrypoints bind source, route to factory and detect drift',async t=>{
 const privateRoot=await fs.mkdtemp(path.join(os.tmpdir(),'factory-installed-'))
 t.after(()=>fs.rm(privateRoot,{recursive:true,force:true}))
 const source=path.join(privateRoot,'source'), installed=path.join(privateRoot,'installed'),stateDir=path.join(privateRoot,'state')
 execFileSync('git',['clone','--quiet','--no-hardlinks',root,source])
 // Deliver candidate files into a fixture commit before installing them.
 for(const name of ['src/orch-installation.mjs','bin/orch-install.mjs','deploy/orch/factory-entry.sh','deploy/orch/test-browser.sh','deploy/orch/branch-wt.sh','deploy/orch/merge-enqueue.sh']){
   await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true})
   await fs.copyFile(path.join(root,name),path.join(source,name))
 }
 execFileSync('git',['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','add','src/orch-installation.mjs','bin/orch-install.mjs','deploy/orch/factory-entry.sh','deploy/orch/test-browser.sh','deploy/orch/branch-wt.sh','deploy/orch/merge-enqueue.sh'])
 execFileSync('git',['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Delivered fixture'])
 const config=path.join(privateRoot,'config.json')
 await fs.writeFile(config,JSON.stringify({stateDir}))
 const receipt=JSON.parse(invoke('install',source,installed,config))
 assert.equal(receipt.sourceRevision,execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim())
 assert.equal(receipt.entrypoint,'bin/pr-delivery.mjs');assert.equal(receipt.stateDir,stateDir)
 assert.equal(JSON.parse(invoke('check',installed)).status,'bound')
 for(const executable of receipt.executables){
   // bound-source probe exercises each actual installed wrapper without model/network work.
   const out=execFileSync('sh',[path.join(installed,executable.path),'--factory-binding'],{encoding:'utf8'})
   const binding=JSON.parse(out);assert.equal(binding.sourceRevision,receipt.sourceRevision)
   assert.equal(binding.entrypoint,receipt.entrypoint)
 }
 await fs.appendFile(path.join(installed,'review-pr.sh'),'\n# drift\n')
 assert.throws(()=>invoke('check',installed),e=>/review-pr.sh.*reinstall/.test(e.stderr.toString()))
 assert.throws(()=>execFileSync('sh',[path.join(installed,'review-pr.sh'),'--factory-binding'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}))
})
